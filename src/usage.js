"use strict";

const acorn = require("acorn");

// Marks a middleware the analysis may trust on a GET request without reading its source: the
// body parsers set it, whose prologue only reads body-framing headers and leaves a bodyless
// GET alone (and a GET that declares a body falls back to the full header copy).
const kGetSafe = Symbol("fulmine.getSafe");

// What a handler may do with `req` and still let the header copy be skipped: members whose
// reads never reach a header. Anything else, computed access included, keeps the copy.
// req.res and req.app are deliberately absent: the walk judges only the member directly on
// the parameter, so anything that can reach another object could reach headers through it.
const REQ_OK = new Set(["query", "params", "body", "method", "path", "url", "baseUrl", "originalUrl", "route"]);

// Reading any of these needs the query string fetched: req.url and req.originalUrl carry it
const REQ_QUERY = new Set(["query", "url", "originalUrl"]);

// Writing any of these re-enters routing: dispatch treats a changed req.url as a rewrite and
// walks routes nobody analyzed, so an assignment is as disqualifying as an unknown call
const REQ_NO_WRITE = new Set(["url", "originalUrl", "path", "baseUrl", "method"]);

// What a handler may do with `res`: writing the response. Anything that negotiates against
// request headers (format, redirect, sendFile, jsonp) is deliberately absent.
const RES_OK = new Set([
    "json",
    "send",
    "end",
    "status",
    "sendStatus",
    "set",
    "setHeader",
    "header",
    "get",
    "type",
    "contentType",
    "append",
    "vary",
    "links",
    "locals",
    "statusCode",
    "writeHead",
    "headersSent",
    "finished",
    "cork"
]);

// what the analysis can say about one callback, as independent facts
const UNKNOWN = 1; // a shape the walk cannot vouch for: could do anything
const NEXT_PLAIN = 2; // calls next() bare: advances the chain, may fall off its end
const NEXT_ERROR = 4; // calls next(err): lands in the framework's own error answer
const QUERY = 8; // reads req.query, req.url or req.originalUrl

const verdicts = new WeakMap();

/**
 * What one callback provably does, as a mask of the facts above. The default is UNKNOWN: any
 * shape this walk does not understand and any alias of req, res or next could do anything.
 * That inversion is what makes source analysis sound to act on.
 *
 * @param {Function} fn
 * @returns {number}
 */
function callbackUsage(fn) {
    if (fn[kGetSafe]) {
        // the body parsers: they advance the chain and read nothing a skip would miss
        return NEXT_PLAIN;
    }
    let verdict = verdicts.get(fn);
    if (verdict === undefined) {
        verdict = analyze(fn);
        verdicts.set(fn, verdict);
    }
    return verdict;
}

/** @param {Function} fn @returns {number} */
function analyze(fn) {
    // toString is application-controlled and may throw or answer anything: unreadable is unknown
    let code;
    try {
        code = String(fn.toString());
    } catch {
        return UNKNOWN;
    }
    if (code.startsWith("function") || code.startsWith("async function")) {
        code = code.replace(/function *\(/, "function __cb(");
    }
    let tree;
    try {
        tree = acorn.parse(code, { ecmaVersion: "latest" });
    } catch {
        // class methods and native functions do not parse alone, and unread code is unknown code
        return UNKNOWN;
    }
    let root = /** @type {any} */ (tree.body[0]);
    if (!root) {
        return UNKNOWN;
    }
    if (root.type === "ExpressionStatement") {
        root = root.expression;
    }
    if (
        root.type !== "FunctionDeclaration" &&
        root.type !== "ArrowFunctionExpression" &&
        root.type !== "FunctionExpression"
    ) {
        return UNKNOWN;
    }

    const params = /** @type {any[]} */ (root.params);
    // rest or destructured parameters alias the objects somewhere the walk cannot follow
    for (const p of params) {
        if (p.type !== "Identifier") {
            return UNKNOWN;
        }
    }
    const reqName = params[0] ? params[0].name : null;
    const resName = params[1] ? params[1].name : null;
    const nextName = params[2] ? params[2].name : null;

    // Every appearance of the three names in the whole body is judged, nested functions
    // included: an inner binding that shadows one of them only makes this stricter, never
    // looser, so scope tracking is not needed for soundness.
    let mask = 0;
    walk(root.body, null, (node, parent) => {
        if (mask & UNKNOWN) {
            return;
        }
        if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier") {
            const owner = node.object.name;
            if (owner !== reqName) {
                return;
            }
            const member = node.property.name;
            if (REQ_QUERY.has(member)) {
                mask |= QUERY;
            }
            // an assignment, an update or a delete on the routing members re-enters dispatch
            if (
                REQ_NO_WRITE.has(member) &&
                parent &&
                ((parent.type === "AssignmentExpression" && parent.left === node) ||
                    (parent.type === "UpdateExpression" && parent.argument === node) ||
                    (parent.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === node))
            ) {
                mask |= UNKNOWN;
            }
            return;
        }
        if (node.type !== "Identifier") {
            return;
        }
        const name = node.name;
        if (name === "eval" || name === "arguments") {
            mask |= UNKNOWN;
            return;
        }
        if (name !== reqName && name !== resName && name !== nextName) {
            return;
        }
        // being renamed inside a member expression (req.query's `query`) is not a use
        if (parent && parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
            return;
        }
        // a redeclaration as an inner parameter or variable name is not a use either
        if (
            parent &&
            (((parent.type === "FunctionDeclaration" ||
                parent.type === "FunctionExpression" ||
                parent.type === "ArrowFunctionExpression") &&
                parent.params.includes(node)) ||
                (parent.type === "VariableDeclarator" && parent.id === node) ||
                (parent.type === "Property" && parent.key === node && !parent.computed))
        ) {
            return;
        }
        if (name === nextName) {
            // calling next is how a chain advances, and past its end or with an error the
            // request lands in the framework's own final answer, which the constructor's
            // accept pre-read covers. Anything but a direct call aliases the continuation,
            // and an argument that could be the string "route" would leave the chain for
            // routes nobody analyzed, so only shapes that cannot be a string pass.
            if (!parent || parent.type !== "CallExpression" || parent.callee !== node) {
                mask |= UNKNOWN;
                return;
            }
            const args = parent.arguments;
            if (args.length === 0) {
                mask |= NEXT_PLAIN;
                return;
            }
            const arg = args[0];
            if (
                args.length > 1 ||
                (arg.type !== "NewExpression" &&
                    arg.type !== "ObjectExpression" &&
                    !(arg.type === "Literal" && typeof arg.value !== "string"))
            ) {
                mask |= UNKNOWN;
                return;
            }
            mask |= NEXT_ERROR;
            return;
        }
        if (!parent || parent.type !== "MemberExpression" || parent.object !== node || parent.computed) {
            mask |= UNKNOWN;
            return;
        }
        const member = parent.property.name;
        if (name === reqName ? !REQ_OK.has(member) : !RES_OK.has(member)) {
            mask |= UNKNOWN;
        }
    });
    return mask;
}

/**
 * Walks every node, handing each its parent. Arrays and nested objects are entered, nothing
 * is interpreted: the judging happens in the visitor.
 *
 * @param {any} node
 * @param {any} parent
 * @param {(node: any, parent: any) => void} visit
 */
function walk(node, parent, visit) {
    if (!node || typeof node.type !== "string") {
        return;
    }
    visit(node, parent);
    for (const key in node) {
        if (key === "type" || key === "start" || key === "end") {
            continue;
        }
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item.type === "string") {
                    walk(item, node, visit);
                }
            }
        } else if (value && typeof value.type === "string") {
            walk(value, node, visit);
        }
    }
}

/**
 * What a native route's whole chain provably never does, so the request constructor may leave
 * that work undone: skipHeaders spares the header copy, skipQuery the query fetch.
 *
 * A callback that calls next() bare passes anywhere but in the terminal route, where it would
 * fall out of the chain: there it only passes when the caller established that no later route
 * could catch the fall-through. The framework's own 404 answers with the path alone, so the
 * fall-through itself needs neither headers nor query.
 *
 * @param {any[]} chain the routes the native handler runs, in order, this route last
 * @param {boolean} allowTerminalNext whether a fall-through past the chain lands only in the
 *   framework's own final answer
 * @returns {{skipHeaders: boolean, skipQuery: boolean}}
 */
function chainUsage(chain, allowTerminalNext) {
    const none = { skipHeaders: false, skipQuery: false };
    let query = false;
    for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        const callbacks = entry.callbacks;
        if (!Array.isArray(callbacks)) {
            return none;
        }
        const terminal = i === chain.length - 1;
        for (const cb of callbacks) {
            if (typeof cb !== "function") {
                return none;
            }
            const mask = callbackUsage(cb);
            if (mask & UNKNOWN || (mask & NEXT_PLAIN && terminal && !allowTerminalNext)) {
                return none;
            }
            if (mask & QUERY) {
                query = true;
            }
        }
        // a param callback runs code this walk never saw
        if (entry.paramCallbacks && entry.paramCallbacks.size > 0) {
            return none;
        }
    }
    return { skipHeaders: true, skipQuery: !query };
}

module.exports = { chainUsage, callbackUsage, kGetSafe, UNKNOWN, NEXT_PLAIN, NEXT_ERROR, QUERY };
