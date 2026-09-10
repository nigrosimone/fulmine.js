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
// H3App, DeclarativeResponse and _cfg exist at runtime but are missing from the .d.ts the
// package ships, so the module is read through a loose alias
const uWS = require("uWebSockets.js");
const uWSAny = /** @type {any} */ (uWS);
const statuses = require("statuses");

/** @typedef {import("./application.js").Application} Application */

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

/** What res.type(x) sets the content type to. A lookup on a literal. */
const typeValueOf = (type) => (type.indexOf("/") === -1 ? contentTypeFor(type) : type);

// what one instruction of a declarative response can carry, since uWS writes its length as a u16
const MAX_INSTRUCTION_LENGTH = 65535;

// Headers used to answer a conditional request. A compiled response cannot read the request, so a
// handler that sets one has to stay on the ordinary path.
const VALIDATOR_HEADERS = new Set(["etag", "last-modified"]);

// Statuses that carry no body. Express strips it for 204 and 304, node answers a 205 with
// Content-Length: 0. All three come out of the ordinary path with no body.
const BODILESS_STATUSES = new Set([204, 205, 304]);

// the three that write a body, only one of them may appear
const bodyMethods = new Set(["send", "json", "end"]);
// the four that finish the response, nothing a handler does after them is observable
const terminalMethods = new Set(["send", "json", "end", "sendStatus"]);

// Node types filterNodes can walk. A missing one is refused because the walk would skip it in
// silence: `res.append("x", "1"), res.send("k")` compiled to a 200 with no body and no headers.
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
 * Every node type in the tree. Walks all the keys instead of named edges, so the answer does not
 * depend on the walk being complete.
 *
 * @param {any} node an acorn node, or an array or a scalar under one: walked by key, so no shape
 *   is assumed
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
 * The key a property writes. Only a plain name or a literal, never computed, a getter or a spread.
 *
 * @param {import("acorn").AnyNode} property an acorn node, a Property when it is one this reads
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
 * The value of a literal expression, for the shapes known at registration time. Anything else
 * throws, and the catch around the compiler turns it into ordinary routing.
 *
 * @param {import("acorn").AnyNode} node
 * @returns {unknown} whatever the literal denotes
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
/**
 * The status and the headers the calls set, in the order they were first written. null when one
 * of them is not a literal this can read.
 *
 * @param {any[]} callExprs the res calls, in run order, each carrying what readResCalls read off
 *   its callee as `obj`; loose because the arguments are taken as whatever literal they hold
 * @param {[string, string][]} headers written to, so the caller keeps the array the body reader also uses
 * @returns {{statusCode: number, sendStatusUsed: boolean}|null}
 */
function readStatusAndHeaders(callExprs, headers) {
    let statusCode = 200;
    // sendStatus and a bare send() both leave the body empty, but sendStatus sends the status
    // message and send() sends nothing
    let sendStatusUsed = false;
    // get statusCode
    for (const call of callExprs) {
        if (call.obj.propertyName === "status") {
            if (call.arguments[0].type !== "Literal") {
                return null;
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
            // type() is set("content-type", ...) after a media type lookup. set() also takes a
            // whole object, one pair per set(). setHeader is node's and takes only strings.
            let pairs;
            if (isType) {
                if (call.arguments[0].type !== "Literal") {
                    return null;
                }
                pairs = [["content-type", typeValueOf(String(call.arguments[0].value))]];
            } else if (call.arguments.length === 1 && call.obj.propertyName !== "setHeader") {
                if (call.arguments[0].type !== "ObjectExpression") {
                    return null;
                }
                pairs = [];
                for (const property of call.arguments[0].properties) {
                    const key = literalKeyOf(property);
                    if (key === null || property.value.type !== "Literal") {
                        return null;
                    }
                    pairs.push([key, String(property.value.value)]);
                }
            } else {
                if (call.arguments[0].type !== "Literal" || call.arguments[1]?.type !== "Literal") {
                    return null;
                }
                // String() here: a numeric literal would reach uWS writeHeader as a number,
                // and uWS refuses anything that is not a string
                pairs = [[call.arguments[0].value, String(call.arguments[1].value)]];
            }

            for (let [header, value] of pairs) {
                const name = String(header).toLowerCase();
                // res.set adds a charset to a content-type, res.setHeader does not: setHeader
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
                    // set replaces the header, so values appended after it go too. Replacing
                    // only the first left the response carrying both.
                    for (let i = headers.length - 1; i > index; i--) {
                        if (String(headers[i][0]).toLowerCase() === name) {
                            headers.splice(i, 1);
                        }
                    }
                }
            }
        } else if (call.obj.propertyName === "append") {
            if (call.arguments[0].type !== "Literal" || call.arguments[1].type !== "Literal") {
                return null;
            }
            headers.push([call.arguments[0].value, String(call.arguments[1].value)]);
        } else if (call.obj.propertyName === "sendStatus") {
            if (call.arguments[0].type !== "Literal") {
                return null;
            }
            statusCode = call.arguments[0].value;
            sendStatusUsed = true;
        }
    }
    return { statusCode, sendStatusUsed };
}

/**
 * The body parts the calls write, pushed into `body`, with the content-type decisions they imply
 * pushed into `headers`. null when one of the calls writes something this cannot read.
 *
 * @param {any[]} callExprs the res calls, in run order, as readStatusAndHeaders takes them
 * @param {[string, string][]} headers the headers read so far, written to
 * @param {any[]} body the body parts, written to; loose because a literal's value is kept as it is
 * @param {Application} app the application, for the json settings
 * @param {string[]} queries names bound by a destructured req.query
 * @param {string[]} params names bound by a destructured req.params
 * @returns {{sendUsed: boolean, bodyFromSend: boolean}|null}
 */
function readBody(callExprs, headers, body, app, queries, params) {
    // get body
    let sendUsed = false;
    // only send() gets an ETag. end() is node's and never computes one, and the ordinary path
    // does the same.
    let bodyFromSend = false;
    for (const call of callExprs) {
        if (bodyMethods.has(call.obj.propertyName)) {
            if (sendUsed) {
                return null;
            }
            // send() with no argument gets no content-type, same as Express and as the ordinary
            // path. It was given one here anyway, so the two paths disagreed on `res.send()`.
            if (call.obj.propertyName !== "end") {
                bodyFromSend = true;
            }
            const arg = call.arguments[0];

            if (call.obj.propertyName === "json") {
                // res.json() with no argument sends no body and no length, a shape left to the
                // ordinary path
                if (!arg) {
                    return null;
                }
                // a replacer runs per response on the ordinary path, so a body computed once
                // could not honour it
                const replacer = app.get("json replacer");
                if (typeof replacer !== "undefined" && typeof replacer !== "string") {
                    return null;
                }
                // json sets a type only when none was chosen, then hands a string to send,
                // which adds the charset to whatever type is there
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
                // The body decides the content-type, so this runs before the body is read.
                // Doing it after made res.set("content-type", "text/plain") + res.send({})
                // answer application/json, where Express answers text/plain.
                const isJsonBody =
                    arg.type === "ObjectExpression" || (arg.type === "Literal" && typeof arg.value === "boolean");
                const isNullBody = arg.type === "Literal" && arg.value === null;
                const existing = headers.find((header) => header[0].toLowerCase() === "content-type");
                if (!existing) {
                    if (isJsonBody) {
                        headers.push(["content-type", "application/json; charset=utf-8"]);
                    } else if (!isNullBody) {
                        // send(null) sends an empty string and chooses no type, the same as
                        // the ordinary path
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
                        return null;
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
                                    return null;
                                }
                                type = obj.property.name;
                            } else if (obj.type === "Identifier") {
                                type = obj.name;
                            } else {
                                return null;
                            }
                            if (type !== "params" && type !== "query") {
                                return null;
                            }
                            body.push({ type, value: expr.property.name });
                        } else if (expr.type === "Identifier") {
                            if (queries.includes(expr.name)) {
                                body.push({ type: "query", value: expr.name });
                            } else if (params.includes(expr.name)) {
                                body.push({ type: "params", value: expr.name });
                            } else {
                                return null;
                            }
                        } else {
                            return null;
                        }
                    }
                } else if (arg.type === "MemberExpression") {
                    if (!arg.object.property) {
                        return null;
                    }
                    if (
                        arg.object.property.type !== "Identifier" ||
                        (arg.object.property.name !== "query" && arg.object.property.name !== "params")
                    ) {
                        return null;
                    }
                    body.push({ type: arg.object.property.name, value: arg.property.name });
                } else if (arg.type === "BinaryExpression") {
                    const stuff = [];
                    /**
                     * Reads a chain of string concatenations right to left. Each side must be a literal or a
                     * param or query value, anything else makes the whole handler fall back.
                     *
                     * @param {any} node a BinaryExpression, read loosely: the literal on either
                     *   side is kept as it is
                     * @returns {boolean}
                     */
                    function check(node) {
                        // only "+" concatenates, any other operator computes a value the parts
                        // cannot hold, so the handler falls back
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
                        return null;
                    }
                    body.push(...stuff.reverse());
                } else if (arg.type === "ObjectExpression") {
                    if (call.obj.propertyName === "end") {
                        return null;
                    }
                    // a replacer runs per response on the ordinary path, so a body computed
                    // once could not honour it
                    const replacer = app.get("json replacer");
                    if (typeof replacer !== "undefined" && typeof replacer !== "string") {
                        return null;
                    }

                    // the content-type was decided above, from what this argument is
                    body.push({
                        type: "text",
                        value: stringify(literalValue(arg), replacer, app.get("json spaces"), app.get("json escape"))
                    });
                } else {
                    return null;
                }
            }
            sendUsed = true;
        }
    }
    return { sendUsed, bodyFromSend };
}
/**
 * The handler's AST and its parameter names, when it is a shape this compiler can read at all.
 * null for anything it cannot: a keyword it does not admit, a node type the walk cannot see
 * through, too few parameters, or a return that is not the last statement.
 *
 * @param {Function} cb
 * @returns {{fn: import("acorn").FunctionDeclaration|import("acorn").ArrowFunctionExpression, args: string[]}|null}
 */
function readHandler(cb) {
    let code = cb.toString();
    // convert anonymous functions to named ones to make it valid code
    if (code.startsWith("function") || code.startsWith("async function")) {
        code = code.replace(/function *\(/, "function __cb(");
    }

    // Anything not understood returns false and falls back to ordinary routing. Widening the
    // list below is not worth it: over the 1113 handlers in tests, demo and benchmark, 42.6%
    // call something that is not res, `const` would unlock 7 (0.6%), a conditional 0.1% more.
    /** @type {any[]} the tokens, loose because acorn's Token type leaves out value */
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
        return null;
    }

    /** @type {any[]} the statements, read loosely: what a parameter may be is checked by hand in readParamNames */
    const parsed = parser.parse(code, { ecmaVersion: "latest" }).body;
    let fn = parsed[0];

    if (fn.type === "ExpressionStatement") {
        fn = fn.expression;
    }

    // check if it is a function
    if (fn.type !== "FunctionDeclaration" && fn.type !== "ArrowFunctionExpression") {
        return null;
    }

    // before reading the tree, because reading is only valid for the shapes the walk can see
    // through
    const nodeTypes = new Set();
    collectNodeTypes(fn, nodeTypes);
    for (const type of nodeTypes) {
        if (!understoodNodeTypes.has(type)) {
            return null;
        }
    }

    const args = fn.params.map((param) => param.name);

    if (args.length < 2) {
        // invalid function? doesn't have (req, res) args
        return null;
    }

    // `return res.send(...)` is the same response as `res.send(...)`, but only as the last
    // statement: every call is read, so a return in the middle would compile dead ones.
    const returns = filterNodes(fn, (node) => node.type === "ReturnStatement");
    if (returns.length) {
        const statements = fn.body.type === "BlockStatement" ? fn.body.body : null;
        if (!statements || returns.length > 1 || returns[0] !== statements[statements.length - 1]) {
            return null;
        }
    }

    return { fn, args };
}

/**
 * What readParamNames found: the two parameter names, and what a destructured req bound.
 * @typedef {object} ParamNames
 * @property {string} req
 * @property {string} res
 * @property {string|undefined} queryName
 * @property {string|undefined} paramsName
 * @property {string[]} queries
 * @property {string[]} params
 */

/**
 * The names a destructured `req` binds for query and params, so the body reader can tell one of
 * them from an identifier it must refuse. null when the pattern is one this cannot read.
 *
 * @param {any} fn the handler's AST, read loosely: a destructured parameter is checked shape by
 *   shape, and anything else throws into the fallback
 * @param {string[]} args its parameter names
 * @returns {ParamNames|null}
 */
function readParamNames(fn, args) {
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
                    return null;
                }
                queries.push(prop.value.name);
            }
        } else {
            return null;
        }

        if (param?.value?.type === "Identifier") {
            paramsName = param.value.name;
        } else if (param?.value?.type === "ObjectPattern") {
            for (const prop of param.value.properties) {
                if (prop.value.type !== "Identifier") {
                    return null;
                }
                params.push(prop.value.name);
            }
        } else {
            return null;
        }
    }
    return { req, res, queryName, paramsName, queries, params };
}

/**
 * Every call the handler makes, in the order they run, cut after the one that writes the body.
 * null when it calls anything but `res`, or a method a compiled response cannot stand for.
 *
 * @param {import("acorn").FunctionDeclaration|import("acorn").ArrowFunctionExpression} fn the handler's AST
 * @param {string} res the name its second parameter was given
 * @returns {any[]|null} the call nodes, each carrying what was read off its callee as `obj`; loose
 *   because the readers take their arguments as whatever literal they hold
 */
function readResCalls(fn, res) {
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
                        return null;
                    }
                    calleeName = callee.object.name;
                }
                break;
            default:
                return null;
        }
        // check if calleeName is res
        if (calleeName !== res) {
            return null;
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
            return null;
        }
    }

    // Sorted in run order. In a chain the walk reaches the outer call first, so
    // res.status(201).status(202) was read backwards. End position orders both cases.
    callExprs.sort((a, b) => a.end - b.end);

    // Nothing after the body call has any effect: on Express res.send("k") then
    // res.status(201) is still a 200. Two calls that both write a body fall back.
    const terminalIndex = callExprs.findIndex((call) => terminalMethods.has(call.obj.propertyName));
    if (terminalIndex !== -1) {
        for (let i = terminalIndex + 1; i < callExprs.length; i++) {
            if (terminalMethods.has(callExprs[i].obj.propertyName)) {
                return null;
            }
        }
        callExprs.length = terminalIndex + 1;
    }
    return callExprs;
}

/**
 * Whether every identifier in the handler is one a compiled response can stand for.
 *
 * @param {import("acorn").FunctionDeclaration|import("acorn").ArrowFunctionExpression} fn the handler's AST
 * @param {string[]} args its parameter names
 * @param {ParamNames} names what a destructured req bound, from readParamNames
 * @returns {boolean}
 */
function identifiersAllowed(fn, args, names) {
    const { req, res, queryName, paramsName, queries, params } = names;
    const identifiers = filterNodes(fn, (node) => node.type === "Identifier")
        .slice(args.length)
        .map((id) => id.name);
    if (identifiers[identifiers.length - 1] === "__cb") {
        identifiers.pop();
    }
    return identifiers.every(
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
    );
}
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
        const handler = readHandler(cb);
        if (handler === null) {
            return false;
        }
        const { fn, args } = handler;

        const names = readParamNames(fn, args);
        if (names === null) {
            return false;
        }
        const { res, queries, params } = names;

        const callExprs = readResCalls(fn, res);
        if (callExprs === null) {
            return false;
        }

        if (!identifiersAllowed(fn, args, names)) {
            return false;
        }

        const headers = [];
        const body = [];

        const status = readStatusAndHeaders(callExprs, headers);
        if (status === null) {
            return false;
        }
        const { statusCode, sendStatusUsed } = status;

        const read = readBody(callExprs, headers, body, app, queries, params);
        if (read === null) {
            return false;
        }
        const { sendUsed, bodyFromSend } = read;

        // a handler that never sends is not a response: Express leaves the request waiting, so this
        // has to fall back instead of answering a bare 200
        if (!sendUsed && !sendStatusUsed) {
            return false;
        }

        // A status that carries no content. Compiled, the body went out anyway, and a client frames
        // these as bodiless, so those bytes were read as the start of the next answer.
        if (BODILESS_STATUSES.has(statusCode) || statusCode < 200) {
            return false;
        }

        let decRes = new uWSAny.DeclarativeResponse();

        if (statusCode !== 200) {
            const statusMessage = statuses.message[statusCode] ?? "unknown";
            decRes = decRes.writeStatus(`${statusCode} ${statusMessage}`);
        }
        // only sendStatus types its body, through res.type("txt"). status(n).end() sends no
        // Content-Type at all, in Express and here
        if (sendStatusUsed && !headers.some((header) => header[0].toLowerCase() === "content-type")) {
            decRes = decRes.writeHeader("content-type", "text/plain; charset=utf-8");
        }

        // the same two the ordinary path seeds every response with. Without them a route answered
        // different headers only because it was compilable, and a client had no idle timeout.
        const advertise = app.get("connection headers") !== false;
        const connection = headers.find((header) => header[0].toLowerCase() === "connection");
        if (!connection && advertise) {
            decRes = decRes.writeHeader("connection", "keep-alive");
        }
        // not when the handler is closing: Keep-Alive describes a connection that stays open, and
        // the ordinary path leaves it out for the same reason
        const closing = typeof connection?.[1] === "string" && connection[1].toLowerCase() === "close";
        if (advertise && !closing && !headers.some((header) => header[0].toLowerCase() === "keep-alive")) {
            decRes = decRes.writeHeader("keep-alive", "timeout=10");
        }

        for (const header of headers) {
            const name = header[0].toLowerCase();
            if (name === "content-length") {
                return false;
            }
            // lowercased like the ordinary path stores them, so both paths answer the same bytes
            // whatever casing the handler wrote, see issue #7
            decRes = decRes.writeHeader(name, header[1]);
        }

        // sendStatus sends the status message as body, and it has to join `body` before the ETag:
        // over an empty body every sendStatus response got the same ETag.
        if (sendStatusUsed && !body.length) {
            body.push({ type: "text", value: statuses.message[statusCode] || String(statusCode) });
        }

        // A response carrying a validator is not compiled: uWS answers without reading the request,
        // so it could never turn a conditional GET into a 304. Use `etag` false to stay compiled.
        if (headers.some((header) => VALIDATOR_HEADERS.has(header[0].toLowerCase()))) {
            return false;
        }
        // an empty body gets no ETag in Express either, so it loses nothing by being compiled
        if (body.length && (bodyFromSend || sendStatusUsed) && app.get("etag")) {
            return false;
        }

        // No Content-Length here: uWS writes the framing itself and a response with both is
        // invalid. Which framing it writes is decided at the end of this function.
        if (app.get("x-powered-by")) {
            decRes = decRes.writeHeader("x-powered-by", "Fulmine");
        }

        // A fully literal body goes out as one end(), so uWS frames it with a Content-Length like
        // Express. A part taken from the request has no length yet, so those are chunked writes.
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
 * Every node matching the predicate, in the order of the named edges below. The edges are written
 * by hand, which is why compileDeclarative first refuses any node type not on the understood list.
 *
 * @param {any} node an acorn node, walked along the named edges below, so nothing is assumed
 *   about its shape
 * @param {(node: import("acorn").AnyNode) => boolean} fn
 * @returns {any[]} the matching nodes, as loose as the input
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

    // singular, not the list above: what a return statement returns and what a unary operator
    // applies to. Without it `return res.send("x")` looked like a body with no calls in it.
    if (node.argument) {
        filtered.push(...filterNodes(node.argument, fn));
    }

    return filtered;
}
