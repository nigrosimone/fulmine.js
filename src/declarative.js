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
const { stringify, contentTypeSet, withUtf8Charset, contentTypeFor, headerIsWritable } = require("./utils.js");
const { loadUWS } = require("./uws.js");
const statuses = require("statuses");

/** @typedef {import("./application.js").Application} Application */
/** @typedef {import("./router.js")} Router */

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

/** @param {string} type what res.type(x) sets the content type to */
const typeValueOf = (type) => (type.indexOf("/") === -1 ? contentTypeFor(type) : type);

// what one instruction of a declarative response can carry, since uWS writes its length as a u16
const MAX_INSTRUCTION_LENGTH = 65535;

// a compiled response cannot read the request, so a handler setting a validator stays ordinary
const VALIDATOR_HEADERS = new Set(["etag", "last-modified"]);

// the statuses the ordinary path answers with no body
const BODILESS_STATUSES = new Set([204, 205, 304]);

// only one of the three that write a body may appear
const bodyMethods = new Set(["send", "json", "end"]);
// nothing a handler does after one of these is observable
const terminalMethods = new Set(["send", "json", "end", "sendStatus"]);

// the node types filterNodes can walk; an unknown one is refused, the walk would skip it in
// silence (`res.append("x", "1"), res.send("k")` compiled to an empty 200)
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
 * Every node type in the tree, by every key rather than the named edges filterNodes walks.
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
 * The key a property writes, a plain name or a literal; null otherwise.
 *
 * @param {import("acorn").AnyNode} property
 * @returns {string|null}
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
 * The value of a literal expression; anything else throws into the compiler's catch.
 *
 * @param {import("acorn").AnyNode} node
 * @returns {unknown}
 */
function literalValue(node) {
    switch (node.type) {
        case "Literal":
            // JSON cannot carry these
            if (node.regex || typeof node.value === "bigint") {
                throw new Error("not serialisable");
            }
            return node.value;
        case "ArrayExpression":
            return node.elements.map((element) => {
                if (element === null || element.type === "SpreadElement") {
                    throw new Error("not a literal");
                }
                return literalValue(element);
            });
        case "ObjectExpression": {
            /** @type {Record<string, unknown>} */
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
            // -1 is a unary minus on a literal
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

/**
 * The status and the headers the calls set, in first-written order; null when one is not a
 * literal this can read.
 *
 * @param {any[]} callExprs the res calls in run order, each carrying `obj` from readResCalls
 * @param {[string, string][]} headers written to
 * @returns {{statusCode: number, sendStatusUsed: boolean}|null}
 */
function readStatusAndHeaders(callExprs, headers) {
    let statusCode = 200;
    // sendStatus sends the status message as body, send() nothing
    let sendStatusUsed = false;
    for (const call of callExprs) {
        if (call.obj.propertyName === "status") {
            if (call.arguments[0].type !== "Literal") {
                return null;
            }
            statusCode = call.arguments[0].value;
        }
    }

    for (const call of callExprs) {
        const isType = call.obj.propertyName === "type" || call.obj.propertyName === "contentType";
        if (
            call.obj.propertyName === "header" ||
            call.obj.propertyName === "setHeader" ||
            call.obj.propertyName === "set" ||
            isType
        ) {
            // type() is set("content-type") after a lookup; set() also takes an object; setHeader
            // is node's and takes only strings
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
                // String(): uWS's writeHeader refuses a number
                pairs = [[call.arguments[0].value, String(call.arguments[1].value)]];
            }

            for (let [header, value] of pairs) {
                const name = String(header).toLowerCase();
                // a chunked framing the handler asked for: a compiled response is one end() with a
                // length, the ordinary path frames it through write(), see Response#writeHeaders
                if (name === "transfer-encoding") {
                    return null;
                }
                // res.set resolves a content-type through the mime database, setHeader does not
                if (call.obj.propertyName !== "setHeader" && name === "content-type") {
                    const resolved = contentTypeSet(String(value));
                    if (resolved === false) {
                        // res.set stores false and the body method picks a type: left to the ordinary path
                        return null;
                    }
                    value = resolved;
                }
                // a name or value setHeader refuses is an error page, left to the ordinary path
                if (!headerIsWritable(String(header), value)) {
                    return null;
                }
                const index = headers.findIndex((entry) => String(entry[0]).toLowerCase() === name);
                if (index === -1) {
                    headers.push([header, value]);
                } else {
                    headers[index][1] = value;
                    // set replaces the header, appended values go too
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
            if (String(call.arguments[0].value).toLowerCase() === "transfer-encoding") {
                return null;
            }
            if (!headerIsWritable(String(call.arguments[0].value), String(call.arguments[1].value))) {
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
 * The body parts the calls write, into `body`, and the content-type they imply, into `headers`;
 * null when a call writes something this cannot read.
 *
 * @param {any[]} callExprs the res calls in run order
 * @param {[string, string][]} headers written to
 * @param {any[]} body written to, a literal's value kept as it is
 * @param {Application|Router} app for the json settings
 * @param {Binding[]} queries what a destructured req.query bound
 * @param {Binding[]} params what a destructured req.params bound
 * @returns {{sendUsed: boolean, bodyFromSend: boolean}|null}
 */
function readBody(callExprs, headers, body, app, queries, params) {
    let sendUsed = false;
    // only send() gets an ETag, end() is node's
    let bodyFromSend = false;
    for (const call of callExprs) {
        if (bodyMethods.has(call.obj.propertyName)) {
            if (sendUsed) {
                return null;
            }
            if (call.obj.propertyName !== "end") {
                bodyFromSend = true;
            }
            // res.end(data, encoding) and res.end(data, cb) cannot be stood for
            if (call.arguments.length > 1) {
                return null;
            }
            const arg = call.arguments[0];

            if (call.obj.propertyName === "json") {
                // res.json() with no argument is left to the ordinary path
                if (!arg) {
                    return null;
                }
                // a replacer function runs per response
                const replacer = app.get("json replacer");
                if (typeof replacer !== "undefined" && typeof replacer !== "string") {
                    return null;
                }
                // json sets a type only when none was chosen, then send adds the charset
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
                // the content-type from the body, before it is read: a set type wins, as Express
                const isJsonBody =
                    arg.type === "ObjectExpression" || (arg.type === "Literal" && typeof arg.value === "boolean");
                const isNullBody = arg.type === "Literal" && arg.value === null;
                const existing = headers.find((header) => header[0].toLowerCase() === "content-type");
                if (!existing) {
                    if (isJsonBody) {
                        headers.push(["content-type", "application/json; charset=utf-8"]);
                    } else if (!isNullBody) {
                        // send(null) chooses no type
                        headers.push(["content-type", "text/html; charset=utf-8"]);
                    }
                } else {
                    existing[1] = withUtf8Charset(String(existing[1]));
                }
            }
            if (arg) {
                if (arg.type === "Literal") {
                    if (typeof arg.value === "number") {
                        return null;
                    }
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
                            // the key, not the local name: a minifier renames the local and uWS
                            // would be asked for a parameter that does not exist
                            const query = queries.find((binding) => binding.local === expr.name);
                            const param = params.find((binding) => binding.local === expr.name);
                            if (query) {
                                body.push({ type: "query", value: query.key });
                            } else if (param) {
                                body.push({ type: "params", value: param.key });
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
                    /** @type {any[]} the parts, in the same loose shape as body */
                    const stuff = [];
                    /**
                     * A chain of string concatenations right to left: each side a literal, a param
                     * or a query value, anything else falls back.
                     *
                     * @param {any} node a BinaryExpression
                     * @returns {boolean}
                     */
                    function check(node) {
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
                    const replacer = app.get("json replacer");
                    if (typeof replacer !== "undefined" && typeof replacer !== "string") {
                        return null;
                    }
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
 * The handler's AST and parameter names, null for a shape this cannot read: a refused keyword,
 * an unknown node type, too few parameters, a return that is not the last statement.
 *
 * @param {Function} cb
 * @returns {{fn: import("acorn").FunctionDeclaration|import("acorn").ArrowFunctionExpression, args: string[]}|null}
 */
function readHandler(cb) {
    let code = cb.toString();
    // an anonymous function is not valid code on its own
    if (code.startsWith("function") || code.startsWith("async function")) {
        code = code.replace(/function *\(/, "function __cb(");
    }

    // widening the list is not worth it: over 1113 handlers in tests, demo and benchmark, 42.6%
    // call something that is not res, `const` would unlock 0.6%, a conditional 0.1%
    /** @type {any[]} loose because acorn's Token type leaves out value */
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

    /** @type {any[]} loose, readParamNames checks the parameters by hand */
    const parsed = parser.parse(code, { ecmaVersion: "latest" }).body;
    let fn = parsed[0];

    if (fn.type === "ExpressionStatement") {
        fn = fn.expression;
    }

    if (fn.type !== "FunctionDeclaration" && fn.type !== "ArrowFunctionExpression") {
        return null;
    }

    // before reading the tree, the walk only sees through these
    const nodeTypes = new Set();
    collectNodeTypes(fn, nodeTypes);
    for (const type of nodeTypes) {
        if (!understoodNodeTypes.has(type)) {
            return null;
        }
    }

    // undefined for a destructured one, which readParamNames reads by hand
    const args = fn.params.map((/** @type {any} */ param) => param.name);

    if (args.length < 2) {
        return null;
    }

    // `return res.send(...)` only as the last statement: a return in the middle would compile dead calls
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
 * @property {Binding[]} queries
 * @property {Binding[]} params
 */

/**
 * One name a destructured req.query or req.params bound, with the key it stands for: the same
 * word in `{ id }`, two after a minifier has been through (`{ id: c }`).
 * @typedef {object} Binding
 * @property {string} local
 * @property {string} key
 */

/**
 * The bindings of one destructuring pattern, `{ id, name: n }`. False for a shape this cannot
 * read: a computed key, a rest element, a default value or a nested pattern.
 *
 * @param {any} pattern an ObjectPattern node
 * @param {Binding[]} into
 * @returns {boolean}
 */
function readBindings(pattern, into) {
    for (const prop of pattern.properties) {
        if (
            prop.type !== "Property" ||
            prop.computed ||
            prop.key.type !== "Identifier" ||
            prop.value.type !== "Identifier"
        ) {
            return false;
        }
        into.push({ local: prop.value.name, key: prop.key.name });
    }
    return true;
}

/**
 * The names a destructured `req` binds for query and params; null for a pattern this cannot read.
 *
 * @param {any} fn the handler's AST
 * @param {string[]} args its parameter names
 * @returns {ParamNames|null}
 */
function readParamNames(fn, args) {
    const [req, res] = args;
    let queryName, paramsName;
    /** @type {Binding[]} */
    const queries = [];
    /** @type {Binding[]} */
    const params = [];

    if (fn.params[0].type === "ObjectPattern") {
        const query = fn.params[0].properties.find((/** @type {any} */ prop) => prop.key.name === "query");
        const param = fn.params[0].properties.find((/** @type {any} */ prop) => prop.key.name === "params");

        if (query?.value?.type === "Identifier") {
            queryName = query.value.name;
        } else if (query?.value?.type === "ObjectPattern") {
            if (!readBindings(query.value, queries)) {
                return null;
            }
        } else {
            return null;
        }

        if (param?.value?.type === "Identifier") {
            paramsName = param.value.name;
        } else if (param?.value?.type === "ObjectPattern") {
            if (!readBindings(param.value, params)) {
                return null;
            }
        } else {
            return null;
        }
    }
    return { req, res, queryName, paramsName, queries, params };
}

/**
 * Every call the handler makes in run order, cut after the one that writes the body; null when
 * it calls anything but `res`, or a method a compiled response cannot stand for.
 *
 * @param {import("acorn").FunctionDeclaration|import("acorn").ArrowFunctionExpression} fn
 * @param {string} res the name its second parameter was given
 * @returns {any[]|null} the call nodes, each carrying `obj` read off its callee
 */
function readResCalls(fn, res) {
    const callExprs = filterNodes(fn, (node) => node.type === "CallExpression");
    const resCalls = [];
    for (const expr of callExprs) {
        let calleeName, propertyName;

        if (expr.type === "MemberExpression") {
            propertyName = expr.property.name;
        } else if (expr.type === "CallExpression") {
            propertyName = expr.callee?.property?.name ?? expr.callee?.name;
        }

        switch (expr.callee.type) {
            case "Identifier":
                calleeName = expr.callee.name;
                break;
            case "MemberExpression":
                if (expr.callee.object.type === "Identifier") {
                    calleeName = expr.callee.object.name;
                } else if (expr.callee.object.type === "CallExpression") {
                    // a chain
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
        if (calleeName !== res) {
            return null;
        }

        const obj = { calleeName, propertyName };
        expr.obj = obj;
        resCalls.push(obj);
    }

    for (const call of resCalls) {
        if (!allowedResMethods.includes(call.propertyName)) {
            return null;
        }
    }

    // run order: in a chain the walk reaches the outer call first
    callExprs.sort((a, b) => a.end - b.end);

    // nothing after the body call has an effect; two body calls fall back
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
 * @param {import("acorn").FunctionDeclaration|import("acorn").ArrowFunctionExpression} fn
 * @param {string[]} args its parameter names
 * @param {ParamNames} names from readParamNames
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
            queries.some((binding) => binding.local === id) ||
            params.some((binding) => binding.local === id)
    );
}
// A uWS declarative response never enters node, so it is very fast. Only a handler that is simple
// enough compiles: no external calls, no variables, only req.query and req.params in the body
/**
 * @param {Function} cb the handler
 * @param {Application|Router} app for the settings
 */
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

        /** @type {[string, string][]} */
        const headers = [];

        const status = readStatusAndHeaders(callExprs, headers);
        if (status === null) {
            return false;
        }
        const { statusCode, sendStatusUsed } = status;

        /** @type {any[]} loose because a literal's value is kept as it is, see readBody */
        const body = [];
        const read = readBody(callExprs, headers, body, app, queries, params);
        if (read === null) {
            return false;
        }
        const { sendUsed, bodyFromSend } = read;

        // a part copied out of the request is written as uWS reads it, only where asked for
        if (!app.get("declarative request values") && body.some((part) => part.type !== "text")) {
            return false;
        }

        // a handler that never sends leaves the request waiting on Express
        if (!sendUsed && !sendStatusUsed) {
            return false;
        }

        // compiled, the body of a bodiless status went out and was read as the next answer
        if (BODILESS_STATUSES.has(statusCode) || statusCode < 200) {
            return false;
        }

        let decRes = new (loadUWS().DeclarativeResponse)();

        if (statusCode !== 200) {
            const statusMessage = statuses.message[statusCode] ?? "unknown";
            decRes = decRes.writeStatus(`${statusCode} ${statusMessage}`);
        }
        // only sendStatus types its body; status(n).end() sends no Content-Type
        if (sendStatusUsed && !headers.some((header) => header[0].toLowerCase() === "content-type")) {
            decRes = decRes.writeHeader("content-type", "text/plain; charset=utf-8");
        }

        // the two the ordinary path seeds every response with, neither once the route wrote its
        // own Connection, as node does
        const advertise = app.get("connection headers") !== false;
        const connection = headers.find((header) => header[0].toLowerCase() === "connection");
        if (!connection && advertise) {
            decRes = decRes.writeHeader("connection", "keep-alive");
        }
        if (advertise && !connection && !headers.some((header) => header[0].toLowerCase() === "keep-alive")) {
            decRes = decRes.writeHeader("keep-alive", "timeout=10");
        }

        for (const header of headers) {
            const name = header[0].toLowerCase();
            if (name === "content-length") {
                return false;
            }
            // lowercased as the ordinary path stores them, see issue #7
            decRes = decRes.writeHeader(name, header[1]);
        }

        // sendStatus's body joins before the ETag check
        if (sendStatusUsed && !body.length) {
            body.push({ type: "text", value: statuses.message[statusCode] || String(statusCode) });
        }

        // a validator cannot answer a conditional GET without reading the request; `etag` false
        // stays compiled, and an empty body gets no ETag in Express either
        if (headers.some((header) => VALIDATOR_HEADERS.has(header[0].toLowerCase()))) {
            return false;
        }
        if (body.length && (bodyFromSend || sendStatusUsed) && app.get("etag")) {
            return false;
        }

        // no Content-Length, uWS writes the framing itself
        if (app.get("x-powered-by")) {
            decRes = decRes.writeHeader("x-powered-by", "Fulmine");
        }

        // a literal body goes out as one end() with a Content-Length as Express; a part from the
        // request is a chunked write
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
 * Every node matching the predicate along the named edges below, which is why compileDeclarative
 * first refuses a node type not on the understood list.
 *
 * @param {any} node
 * @param {(node: import("acorn").AnyNode) => boolean} fn
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

    // singular: what a return returns and a unary operator applies to
    if (node.argument) {
        filtered.push(...filterNodes(node.argument, fn));
    }

    return filtered;
}
