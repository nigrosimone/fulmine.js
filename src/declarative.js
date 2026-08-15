/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

This file is derived from Ultimate Express and has been modified.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const acorn = require("acorn");
const { stringify, withDefaultCharset, withUtf8Charset, contentTypeFor } = require("./utils.js");
// H3App, DeclarativeResponse and _cfg all exist at runtime but are missing from the
// declaration file the package ships, so the module is read through a loose alias
const uWS = require("uWebSockets.js");
const uWSAny = /** @type {any} */ (uWS);
const statuses = require("statuses");

const parser = acorn.Parser;

const allowedResMethods = [
    "set",
    "header",
    "setHeader",
    "type",
    "contentType",
    "sendStatus",
    "status",
    "send",
    "json",
    "end",
    "append"
];

const allowedIdentifiers = ["query", "params", ...allowedResMethods];

/** What res.type(x) sets the content type to, which is a lookup on a literal. */
const typeValueOf = (type) => (type.indexOf("/") === -1 ? contentTypeFor(type) : type);

// what one instruction of a declarative response can carry, since uWS writes its length as a u16
const MAX_INSTRUCTION_LENGTH = 65535;

// the three that write a body, of which only one may appear
// The headers a conditional request is answered from. A compiled response cannot read the request,
// so it cannot honour one, and a handler that sets one has to stay on the ordinary path.
const VALIDATOR_HEADERS = new Set(["etag", "last-modified"]);

const bodyMethods = new Set(["send", "json", "end"]);
// and the four that finish the response, after which nothing a handler does is observable
const terminalMethods = new Set(["send", "json", "end", "sendStatus"]);

// Every node type the walk in filterNodes knows how to step through. A type that is missing here
// is not rejected for being dangerous, it is rejected because the walk would step over it without
// saying so: a sequence expression hid its calls completely, and `res.append("x", "1"), res.send("k")`
// compiled into a 200 with no body and no headers at all. Anything unfamiliar falls back to
// ordinary routing, which is always correct if slower.
const understoodNodeTypes = new Set([
    "ArrowFunctionExpression",
    "FunctionDeclaration",
    "FunctionExpression",
    "BlockStatement",
    "ExpressionStatement",
    "ReturnStatement",
    "CallExpression",
    "MemberExpression",
    "Identifier",
    "Literal",
    "TemplateLiteral",
    "TemplateElement",
    "ObjectExpression",
    "ArrayExpression",
    "Property",
    "BinaryExpression",
    "UnaryExpression",
    "ObjectPattern"
]);

/**
 * Every node type in the tree, found by walking whatever is there rather than by following named
 * edges, so that the answer does not depend on the walk being complete.
 *
 * @param {any} node
 * @param {Set<string>} types
 */
function collectNodeTypes(node, types) {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) collectNodeTypes(child, types);
        return;
    }
    if (typeof node.type === "string") {
        types.add(node.type);
    }
    for (const key in node) {
        if (key === "type" || key === "start" || key === "end") continue;
        collectNodeTypes(node[key], types);
    }
}

/**
 * The key a property writes, when it is one this can read: a plain name or a literal, never
 * computed and never a getter or a spread.
 *
 * @param {any} property
 * @returns {string|null} null when the shape is not one of those
 */
function literalKeyOf(property) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") {
        return null;
    }
    if (property.key.type === "Identifier") {
        return property.key.name;
    }
    return property.key.type === "Literal" ? String(property.key.value) : null;
}

/**
 * The value a literal expression denotes, for the shapes whose value is known at registration
 * time. Anything else throws, which the catch around the whole compiler turns into ordinary
 * routing: a response written once cannot contain something only a request could produce.
 *
 * This replaced reading the value back out of the source text, which could not see through a
 * nested object or an array and needed a regular expression to re-quote the keys.
 *
 * @param {any} node
 * @returns {any}
 */
function literalValue(node) {
    switch (node.type) {
        case "Literal":
            // a regular expression and a bigint are literals that JSON cannot carry
            if (node.regex || typeof node.value === "bigint") {
                throw new Error("not serialisable");
            }
            return node.value;
        case "ArrayExpression":
            return node.elements.map((element) => {
                // a hole, as in [1, , 2], and a spread, which needs something to spread
                if (element === null || element.type === "SpreadElement") {
                    throw new Error("not a literal");
                }
                return literalValue(element);
            });
        case "ObjectExpression": {
            const out = {};
            for (const property of node.properties) {
                if (property.type !== "Property" || property.computed || property.kind !== "init") {
                    throw new Error("not a literal");
                }
                const key =
                    property.key.type === "Identifier"
                        ? property.key.name
                        : property.key.type === "Literal"
                          ? String(property.key.value)
                          : null;
                if (key === null) {
                    throw new Error("not a literal");
                }
                out[key] = literalValue(property.value);
            }
            return out;
        }
        case "UnaryExpression":
            // -1 is a unary minus applied to a literal, not a literal
            if (node.operator === "-" || node.operator === "+") {
                const value = literalValue(node.argument);
                if (typeof value !== "number") {
                    throw new Error("not a literal");
                }
                return node.operator === "-" ? -value : value;
            }
            throw new Error("not a literal");
        default:
            throw new Error("not a literal");
    }
}

// generates a declarative response from a callback
// uWS allows creating such responses and they are extremely fast
// since you don't even have to call into Node.js at all
// declarative response will only be created if callback is 'simple enough'
// simple enough means:
// - doesnt call external functions
// - doesnt create variables
// - only uses req.query and req.params
// basically, its only simple, static responses
module.exports = function compileDeclarative(cb, app) {
    try {
        let code = cb.toString();
        // convert anonymous functions to named ones to make it valid code
        if (code.startsWith("function") || code.startsWith("async function")) {
            code = code.replace(/function *\(/, "function __cb(");
        }

        // Everything below runs inside the try above, and any shape this does not understand falls
        // out as `return false`, which is the fallback to ordinary routing. That is the design, and
        // it is why the tree is walked loosely: acorn types every shape JavaScript can take, and
        // enumerating them here would be a second, worse copy of that catch.
        //
        // The list below looks like the thing to widen, and it is not. Counted over the 1113
        // handlers in this repository's tests, demo and benchmark scenarios: 42.6% call something
        // that is not res, which no syntax admitted here can reach, and admitting `const` would
        // unlock 7 handlers, 0.6%, one conditional a further 0.1%. On the demo and the benchmark
        // alone, where the handlers look more like an application's, the share that calls something
        // rises to 59% and the two would unlock nothing at all. What keeps a route off this path is
        // that its answer is not knowable until the request arrives, and a variable is only another
        // way to spell an answer that already was.
        /** @type {any[]} */
        const tokens = [...acorn.tokenizer(code, { ecmaVersion: "latest" })];

        if (
            tokens.some((token) =>
                [
                    "throw",
                    "new",
                    "await",
                    "try",
                    "catch",
                    "finally",
                    "if",
                    "else",
                    "switch",
                    "case",
                    "default",
                    "for",
                    "while",
                    "do",
                    "var",
                    "let",
                    "const"
                ].includes(token.value)
            )
        ) {
            return false;
        }

        /** @type {any[]} */
        const parsed = parser.parse(code, { ecmaVersion: "latest" }).body;
        let fn = parsed[0];

        if (fn.type === "ExpressionStatement") {
            fn = fn.expression;
        }

        // check if it is a function
        if (fn.type !== "FunctionDeclaration" && fn.type !== "ArrowFunctionExpression") {
            return false;
        }

        // before anything is read out of the tree, since reading it is only meaningful for the
        // shapes the walk can see through
        const nodeTypes = new Set();
        collectNodeTypes(fn, nodeTypes);
        for (const type of nodeTypes) {
            if (!understoodNodeTypes.has(type)) {
                return false;
            }
        }

        const args = fn.params.map((param) => param.name);

        if (args.length < 2) {
            // invalid function? doesn't have (req, res) args
            return false;
        }

        // `return res.send(...)` describes the same response as `res.send(...)` and is written far
        // more often, so it is worth reading. It only describes the same response when nothing
        // follows it: every call in the body is read, whether or not it can be reached, so a return
        // in the middle would compile statements that never run. A return inside a nested function
        // fails the same test, not being the last statement of this one.
        const returns = filterNodes(fn, (node) => node.type === "ReturnStatement");
        if (returns.length) {
            const statements = fn.body.type === "BlockStatement" ? fn.body.body : null;
            if (!statements || returns.length > 1 || returns[0] !== statements[statements.length - 1]) {
                return false;
            }
        }

        const [req, res] = args;
        let queryName, paramsName;
        const queries = [],
            params = [];

        if (fn.params[0].type === "ObjectPattern") {
            const query = fn.params[0].properties.find((prop) => prop.key.name === "query");
            const param = fn.params[0].properties.find((prop) => prop.key.name === "params");

            if (query?.value?.type === "Identifier") {
                queryName = query.value.name;
            } else if (query?.value?.type === "ObjectPattern") {
                for (const prop of query.value.properties) {
                    if (prop.value.type !== "Identifier") {
                        return false;
                    }
                    queries.push(prop.value.name);
                }
            } else {
                return false;
            }

            if (param?.value?.type === "Identifier") {
                paramsName = param.value.name;
            } else if (param?.value?.type === "ObjectPattern") {
                for (const prop of param.value.properties) {
                    if (prop.value.type !== "Identifier") {
                        return false;
                    }
                    params.push(prop.value.name);
                }
            } else {
                return false;
            }
        }

        // check if it calls any other function other than the one in `res`
        const callExprs = filterNodes(fn, (node) => node.type === "CallExpression");
        const resCalls = [];
        for (const expr of callExprs) {
            let calleeName, propertyName;

            // get propertyName
            if (expr.type === "MemberExpression") {
                propertyName = expr.property.name;
            } else if (expr.type === "CallExpression") {
                propertyName = expr.callee?.property?.name ?? expr.callee?.name;
            }

            // get calleeName
            switch (expr.callee.type) {
                case "Identifier":
                    calleeName = expr.callee.name;
                    break;
                case "MemberExpression":
                    if (expr.callee.object.type === "Identifier") {
                        calleeName = expr.callee.object.name;
                    } else if (expr.callee.object.type === "CallExpression") {
                        // function call chaining
                        let callee = expr.callee;
                        while (callee.object.callee) {
                            callee = callee.object.callee;
                        }
                        if (callee.object.type !== "Identifier") {
                            return false;
                        }
                        calleeName = callee.object.name;
                    }
                    break;
                default:
                    return false;
            }
            // check if calleeName is res
            if (calleeName !== res) {
                return false;
            }

            const obj = { calleeName, propertyName };
            expr.obj = obj;
            resCalls.push(obj);
        }

        // check if res property being called are
        // - set, header, setHeader
        // - status
        // - send
        // - end
        for (const call of resCalls) {
            if (!allowedResMethods.includes(call.propertyName)) {
                return false;
            }
        }

        // In the order the calls run, which for a chain is not the order the tree is walked in:
        // res.status(201) is a node inside res.status(201).send("k"), so the walk reaches the outer
        // call first and read res.status(201).status(202) backwards. Ending position orders a chain
        // and separate statements alike.
        callExprs.sort((a, b) => a.end - b.end);

        // Nothing after the call that writes the body has any effect, since by then the response
        // has gone out: res.sendStatus(404) followed by res.set("x-a", "1") sends no x-a on
        // Express, and res.send("k") followed by res.status(201) is still a 200. Two calls that
        // each write a body is a mistake rather than a shape worth compiling, and falls back.
        const terminalIndex = callExprs.findIndex((call) => terminalMethods.has(call.obj.propertyName));
        if (terminalIndex !== -1) {
            for (let i = terminalIndex + 1; i < callExprs.length; i++) {
                if (terminalMethods.has(callExprs[i].obj.propertyName)) {
                    return false;
                }
            }
            callExprs.length = terminalIndex + 1;
        }

        // check if all identifiers are allowed
        const identifiers = filterNodes(fn, (node) => node.type === "Identifier")
            .slice(args.length)
            .map((id) => id.name);
        if (identifiers[identifiers.length - 1] === "__cb") {
            identifiers.pop();
        }
        if (
            !identifiers.every(
                (id, i) =>
                    allowedIdentifiers.includes(id) ||
                    id === req ||
                    id === res ||
                    (identifiers[i - 2] === req && identifiers[i - 1] === "params") ||
                    (identifiers[i - 2] === req && identifiers[i - 1] === "query") ||
                    id === queryName ||
                    id === paramsName ||
                    queries.includes(id) ||
                    params.includes(id)
            )
        ) {
            return false;
        }

        let statusCode = 200;
        // sendStatus and a bare send() both leave the body empty, and they mean different things:
        // one sends the status message, the other sends nothing
        let sendStatusUsed = false;
        const headers = [];
        const body = [];

        // get statusCode
        for (const call of callExprs) {
            if (call.obj.propertyName === "status") {
                if (call.arguments[0].type !== "Literal") {
                    return false;
                }
                statusCode = call.arguments[0].value;
            }
        }

        // get headers
        for (const call of callExprs) {
            const isType = call.obj.propertyName === "type" || call.obj.propertyName === "contentType";
            if (
                call.obj.propertyName === "header" ||
                call.obj.propertyName === "setHeader" ||
                call.obj.propertyName === "set" ||
                isType
            ) {
                // type() is set("content-type", ...) with the media type looked up first, and
                // set() takes a whole object as well, which is one set() per pair. setHeader is
                // node's and throws on anything but a string, so it is not offered the object.
                let pairs;
                if (isType) {
                    if (call.arguments[0].type !== "Literal") {
                        return false;
                    }
                    pairs = [["content-type", typeValueOf(String(call.arguments[0].value))]];
                } else if (call.arguments.length === 1 && call.obj.propertyName !== "setHeader") {
                    if (call.arguments[0].type !== "ObjectExpression") {
                        return false;
                    }
                    pairs = [];
                    for (const property of call.arguments[0].properties) {
                        const key = literalKeyOf(property);
                        if (key === null || property.value.type !== "Literal") {
                            return false;
                        }
                        pairs.push([key, String(property.value.value)]);
                    }
                } else {
                    if (call.arguments[0].type !== "Literal" || call.arguments[1]?.type !== "Literal") {
                        return false;
                    }
                    // String() at capture: a numeric literal would reach uWS's writeHeader as
                    // itself, and uWS refuses anything that is not a string
                    pairs = [[call.arguments[0].value, String(call.arguments[1].value)]];
                }

                for (let [header, value] of pairs) {
                    const name = String(header).toLowerCase();
                    // res.set charsets a content-type and res.setHeader does not, since the second
                    // is node's and node does not know what a media type is
                    if (call.obj.propertyName !== "setHeader" && name === "content-type") {
                        value = withDefaultCharset(value);
                    }
                    const index = headers.findIndex((entry) => String(entry[0]).toLowerCase() === name);
                    if (index === -1) {
                        headers.push([header, value]);
                    } else {
                        // in place, so the header keeps the position it was first given
                        headers[index][1] = value;
                        // set replaces the header outright, so any further value append left there
                        // goes with it. Replacing only the first left the response carrying both.
                        for (let i = headers.length - 1; i > index; i--) {
                            if (String(headers[i][0]).toLowerCase() === name) {
                                headers.splice(i, 1);
                            }
                        }
                    }
                }
            } else if (call.obj.propertyName === "append") {
                if (call.arguments[0].type !== "Literal" || call.arguments[1].type !== "Literal") {
                    return false;
                }
                headers.push([call.arguments[0].value, String(call.arguments[1].value)]);
            } else if (call.obj.propertyName === "sendStatus") {
                if (call.arguments[0].type !== "Literal") {
                    return false;
                }
                statusCode = call.arguments[0].value;
                sendStatusUsed = true;
            }
        }

        // get body
        let sendUsed = false;
        // only send() earns an ETag. end() is node's, which never computes one, and the ordinary
        // path here follows that too, so the compiled path has to as well.
        let bodyFromSend = false;
        for (const call of callExprs) {
            if (bodyMethods.has(call.obj.propertyName)) {
                if (sendUsed) {
                    return false;
                }
                // send() with nothing to send gets no content-type, the same as on the ordinary
                // path and the same as Express. It was being given one here regardless, so the
                // two paths disagreed about a route as simple as `res.send()`.
                if (call.obj.propertyName !== "end") {
                    bodyFromSend = true;
                }
                const arg = call.arguments[0];

                if (call.obj.propertyName === "json") {
                    // res.json() with nothing to serialise sends no body and no length, which is a
                    // shape worth leaving to the ordinary path rather than reproducing here
                    if (!arg) {
                        return false;
                    }
                    // a replacer runs per response on the ordinary path, so a body computed once
                    // could not honour it
                    const replacer = app.get("json replacer");
                    if (typeof replacer !== "undefined" && typeof replacer !== "string") {
                        return false;
                    }
                    // json reaches for a type only when none was chosen, then hands a string to
                    // send, which is what charsets whatever type is there
                    const existing = headers.find((header) => header[0].toLowerCase() === "content-type");
                    if (existing) {
                        existing[1] = withUtf8Charset(String(existing[1]));
                    } else {
                        headers.push(["content-type", "application/json; charset=utf-8"]);
                    }
                    body.push({
                        type: "text",
                        value: stringify(literalValue(arg), replacer, app.get("json spaces"), app.get("json escape"))
                    });
                    sendUsed = true;
                    continue;
                }

                if (call.obj.propertyName === "send" && arg) {
                    // What the body is decides which content-type it would be given, so this comes
                    // before the body is read rather than after. Setting one and then overwriting
                    // it, which is what happened here, meant res.set("content-type", "text/plain")
                    // followed by res.send({}) answered application/json where Express answers
                    // text/plain: send only reaches for a type when none was chosen.
                    const isJsonBody =
                        arg.type === "ObjectExpression" || (arg.type === "Literal" && typeof arg.value === "boolean");
                    const isNullBody = arg.type === "Literal" && arg.value === null;
                    const existing = headers.find((header) => header[0].toLowerCase() === "content-type");
                    if (!existing) {
                        if (isJsonBody) {
                            headers.push(["content-type", "application/json; charset=utf-8"]);
                        } else if (!isNullBody) {
                            // send(null) sends an empty string without choosing a type, the same
                            // as it does on the ordinary path
                            headers.push(["content-type", "text/html; charset=utf-8"]);
                        }
                    } else {
                        existing[1] = withUtf8Charset(String(existing[1]));
                    }
                }
                if (arg) {
                    if (arg.type === "Literal") {
                        if (typeof arg.value === "number") {
                            // status code
                            return false;
                        }
                        // the content-type was decided above, from what this argument is
                        const val = arg.value === null ? "" : arg.value;
                        body.push({ type: "text", value: val });
                    } else if (arg.type === "TemplateLiteral") {
                        const exprs = [...arg.quasis, ...arg.expressions].sort((a, b) => a.start - b.start);
                        for (const expr of exprs) {
                            if (expr.type === "TemplateElement") {
                                body.push({ type: "text", value: expr.value.cooked });
                            } else if (expr.type === "MemberExpression") {
                                const obj = expr.object;
                                let type;
                                if (obj.type === "MemberExpression") {
                                    if (obj.property.type !== "Identifier") {
                                        return false;
                                    }
                                    type = obj.property.name;
                                } else if (obj.type === "Identifier") {
                                    type = obj.name;
                                } else {
                                    return false;
                                }
                                if (type !== "params" && type !== "query") {
                                    return false;
                                }
                                body.push({ type, value: expr.property.name });
                            } else if (expr.type === "Identifier") {
                                if (queries.includes(expr.name)) {
                                    body.push({ type: "query", value: expr.name });
                                } else if (params.includes(expr.name)) {
                                    body.push({ type: "params", value: expr.name });
                                } else {
                                    return false;
                                }
                            } else {
                                return false;
                            }
                        }
                    } else if (arg.type === "MemberExpression") {
                        if (!arg.object.property) {
                            return false;
                        }
                        if (
                            arg.object.property.type !== "Identifier" ||
                            (arg.object.property.name !== "query" && arg.object.property.name !== "params")
                        ) {
                            return false;
                        }
                        body.push({ type: arg.object.property.name, value: arg.property.name });
                    } else if (arg.type === "BinaryExpression") {
                        const stuff = [];
                        /**
                         * Reads a chain of string concatenations right to left, collecting each side as either a
                         * literal or a param or query value. Returns false for anything else, which is what makes
                         * the whole handler fall back.
                         *
                         * @param {any} node a BinaryExpression
                         * @returns {boolean}
                         */
                        function check(node) {
                            // only "+" concatenates; any other operator computes a value the
                            // parts cannot represent, so the handler falls back
                            if (node.operator !== "+") {
                                return false;
                            }
                            if (node.right.type === "Literal") {
                                stuff.push({ type: "text", value: node.right.value });
                            } else if (node.right.type === "MemberExpression") {
                                stuff.push({ type: node.right.object.property.name, value: node.right.property.name });
                            } else return false;
                            if (node.left.type === "Literal") {
                                stuff.push({ type: "text", value: node.left.value });
                            } else if (node.left.type === "MemberExpression") {
                                stuff.push({ type: node.left.object.property.name, value: node.left.property.name });
                            } else if (node.left.type === "BinaryExpression") {
                                return check(node.left);
                            } else return false;

                            return true;
                        }
                        if (!check(arg)) {
                            return false;
                        }
                        body.push(...stuff.reverse());
                    } else if (arg.type === "ObjectExpression") {
                        if (call.obj.propertyName === "end") {
                            return false;
                        }
                        // a replacer runs per response on the ordinary path, so a body computed
                        // once could not honour it
                        const replacer = app.get("json replacer");
                        if (typeof replacer !== "undefined" && typeof replacer !== "string") {
                            return false;
                        }

                        // the content-type was decided above, from what this argument is
                        body.push({
                            type: "text",
                            value: stringify(
                                literalValue(arg),
                                replacer,
                                app.get("json spaces"),
                                app.get("json escape")
                            )
                        });
                    } else {
                        return false;
                    }
                }
                sendUsed = true;
            }
        }

        // a handler that never sends is not a response: Express leaves the request waiting, so
        // compiling the empty shape would answer a bare 200 where the ordinary path answers
        // nothing at all. It has to fall back instead.
        if (!sendUsed && !sendStatusUsed) {
            return false;
        }

        let decRes = new uWSAny.DeclarativeResponse();

        if (statusCode !== 200) {
            const statusMessage = statuses.message[statusCode] ?? "unknown";
            decRes = decRes.writeStatus(`${statusCode} ${statusMessage}`);
        }
        // only sendStatus types its body: it goes through res.type("txt") on the ordinary path,
        // while status(n).end() sends no Content-Type at all, in Express and here alike
        if (sendStatusUsed && !headers.some((header) => header[0].toLowerCase() === "content-type")) {
            decRes = decRes.writeHeader("content-type", "text/plain; charset=utf-8");
        }

        // the same two the ordinary path seeds every response with. Without them a route answered
        // different headers depending only on whether it happened to be compilable, which is worse
        // than either choice on its own, and a client had no idle timeout to go on.
        const advertise = app.get("connection headers") !== false;
        const connection = headers.find((header) => header[0].toLowerCase() === "connection");
        if (!connection && advertise) {
            decRes = decRes.writeHeader("connection", "keep-alive");
        }
        // not on a connection the handler is closing: Keep-Alive describes one that is staying
        // open, and the ordinary path leaves it out for the same reason
        const closing = typeof connection?.[1] === "string" && connection[1].toLowerCase() === "close";
        if (advertise && !closing && !headers.some((header) => header[0].toLowerCase() === "keep-alive")) {
            decRes = decRes.writeHeader("keep-alive", "timeout=10");
        }

        for (const header of headers) {
            if (header[0].toLowerCase() === "content-length") {
                return false;
            }
            decRes = decRes.writeHeader(header[0], header[1]);
        }

        // sendStatus sends the status message as its body. It has to join `body` here, before the
        // ETag is computed, and not at write time: computing the ETag over an empty body gave every
        // sendStatus response the same one, so a cache could not tell a 404 from a 500 and a
        // conditional request could be answered 304 with the wrong body entirely.
        if (sendStatusUsed && !body.length) {
            body.push({ type: "text", value: statuses.message[statusCode] || String(statusCode) });
        }

        // A response that would carry a validator is not compiled at all.
        //
        // µWS answers a declarative response without reading the request, so it cannot answer a
        // conditional GET: it used to write an ETag computed over the compiled body at listen and
        // then ignore it, so every revalidation got 200 and the whole body where Express answers
        // 304 with none. Dropping the ETag instead would have kept the route compiled, at the
        // price of no validator at all on the simplest routes of every application. Refusing
        // keeps Express's answer, and `etag` false is how a route that does not need one stays
        // compiled, which is what both benchmarks here already set.
        if (headers.some((header) => VALIDATOR_HEADERS.has(header[0].toLowerCase()))) {
            return false;
        }
        // an empty body gets no ETag, in Express and on the ordinary path here, so it has nothing
        // to lose by being compiled
        if (body.length && (bodyFromSend || sendStatusUsed) && app.get("etag")) {
            return false;
        }

        // No Content-Length header here: uWS writes the framing itself, and a response carrying
        // both is invalid. Which framing it writes is decided at the end of this function.
        if (app.get("x-powered-by")) {
            decRes = decRes.writeHeader("x-powered-by", "Fulmine");
        }

        // A body that is literal all the way through goes out as one end(), which is what makes
        // uWS frame it with a Content-Length, as Express does. A part interpolated from the
        // request has no length until the request arrives, so those stay a write each and uWS
        // chunks them.
        const literal = body.every((part) => part.type === "text")
            ? body.map((part) => String(part.value)).join("")
            : null;
        if (literal && literal.length <= MAX_INSTRUCTION_LENGTH) {
            return decRes.end(literal);
        }

        for (const bodyPart of body) {
            if (bodyPart.type === "text" && String(bodyPart.value).length) {
                decRes = decRes.write(String(bodyPart.value));
            } else if (bodyPart.type === "params") {
                decRes = decRes.writeParameterValue(bodyPart.value);
            } else if (bodyPart.type === "query") {
                decRes = decRes.writeQueryValue(bodyPart.value);
            }
        }

        return decRes.end();
    } catch (e) {
        return false;
    }
};

/**
 * Every node in the tree matching the predicate, in the order the named edges below are followed.
 * The edges are written out rather than discovered, which is why compileDeclarative first refuses
 * any node type that is not on the understood list: a shape this walk cannot see through would
 * otherwise be compiled as though it were empty.
 *
 * @param {any} node
 * @param {(node: any) => boolean} fn
 * @returns {any[]}
 */
function filterNodes(node, fn) {
    const filtered = [];
    if (fn(node)) {
        filtered.push(node);
    }
    if (node.params) {
        for (const param of node.params) {
            filtered.push(...filterNodes(param, fn));
        }
    }

    if (node.body) {
        if (Array.isArray(node.body)) {
            for (const child of node.body) {
                filtered.push(...filterNodes(child, fn));
            }
        } else {
            filtered.push(...filterNodes(node.body, fn));
        }
    }

    if (node.declarations) {
        for (const declaration of node.declarations) {
            filtered.push(...filterNodes(declaration, fn));
        }
    }

    if (node.expression) {
        filtered.push(...filterNodes(node.expression, fn));
    }

    if (node.callee) {
        filtered.push(...filterNodes(node.callee, fn));
    }

    if (node.object) {
        filtered.push(...filterNodes(node.object, fn));
    }

    if (node.property) {
        filtered.push(...filterNodes(node.property, fn));
    }

    if (node.id) {
        filtered.push(...filterNodes(node.id, fn));
    }
    if (node.init) {
        filtered.push(...filterNodes(node.init, fn));
    }

    if (node.left) {
        filtered.push(...filterNodes(node.left, fn));
    }
    if (node.right) {
        filtered.push(...filterNodes(node.right, fn));
    }

    if (node.arguments) {
        for (const argument of node.arguments) {
            filtered.push(...filterNodes(argument, fn));
        }
    }

    // singular, and not the list above: it is what a return statement returns, and what a unary
    // operator applies to. Without it `return res.send("x")` looked like a body with no calls in
    // it at all, which would have compiled into an empty response.
    if (node.argument) {
        filtered.push(...filterNodes(node.argument, fn));
    }

    return filtered;
}
