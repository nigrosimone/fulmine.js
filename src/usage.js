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

// what the analysis can say about one callback
const NO = 0; // could read headers, or could not be read at all
const SAFE = 1; // never reads a header, never touches next
const SAFE_NEXT = 2; // never reads a header, calls next: fine mid-chain, and at the end of
// the chain only when no later route could catch the fall-through

const verdicts = new WeakMap();

/**
 * What one callback provably does. The default is NO: any shape this walk does not understand
 * and any alias of req, res or next keeps the header copy. That inversion is what makes
 * source analysis sound to act on.
 *
 * @param {Function} fn
 * @returns {number} NO, SAFE or SAFE_NEXT
 */
function callbackSkipsHeaders(fn) {
    if (fn[kGetSafe]) {
        return SAFE_NEXT;
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
    let code = fn.toString();
    if (code.startsWith("function") || code.startsWith("async function")) {
        code = code.replace(/function *\(/, "function __cb(");
    }
    let tree;
    try {
        tree = acorn.parse(code, { ecmaVersion: "latest" });
    } catch {
        // class methods and native functions do not parse alone, and unread code is unknown code
        return NO;
    }
    let root = /** @type {any} */ (tree.body[0]);
    if (!root) {
        return NO;
    }
    if (root.type === "ExpressionStatement") {
        root = root.expression;
    }
    if (
        root.type !== "FunctionDeclaration" &&
        root.type !== "ArrowFunctionExpression" &&
        root.type !== "FunctionExpression"
    ) {
        return NO;
    }

    const params = /** @type {any[]} */ (root.params);
    // rest or destructured parameters alias the objects somewhere the walk cannot follow
    for (const p of params) {
        if (p.type !== "Identifier") {
            return NO;
        }
    }
    const reqName = params[0] ? params[0].name : null;
    const resName = params[1] ? params[1].name : null;
    const nextName = params[2] ? params[2].name : null;

    // Every appearance of the three names in the whole body is judged, nested functions
    // included: an inner binding that shadows one of them only makes this stricter, never
    // looser, so scope tracking is not needed for soundness.
    let ok = true;
    let usesNext = false;
    walk(root.body, null, (node, parent) => {
        if (!ok || node.type !== "Identifier") {
            return;
        }
        const name = node.name;
        if (name === "eval" || name === "arguments") {
            ok = false;
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
            // request lands in the framework's own final handler, which the constructor's
            // accept pre-read covers. Anything but a direct call aliases the continuation,
            // and an argument that could be the string "route" would leave the chain for
            // routes nobody analyzed, so only shapes that cannot be a string pass.
            if (!parent || parent.type !== "CallExpression" || parent.callee !== node) {
                ok = false;
                return;
            }
            usesNext = true;
            const args = parent.arguments;
            if (args.length === 0) {
                return;
            }
            const arg = args[0];
            if (
                args.length > 1 ||
                (arg.type !== "NewExpression" &&
                    arg.type !== "ObjectExpression" &&
                    !(arg.type === "Literal" && typeof arg.value !== "string"))
            ) {
                ok = false;
            }
            return;
        }
        if (!parent || parent.type !== "MemberExpression" || parent.object !== node || parent.computed) {
            ok = false;
            return;
        }
        const member = parent.property.name;
        if (name === reqName ? !REQ_OK.has(member) : !RES_OK.has(member)) {
            ok = false;
        }
    });
    return ok ? (usesNext ? SAFE_NEXT : SAFE) : NO;
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
 * Whether a native literal route's whole chain provably never reads a request header, so the
 * request constructor may skip copying them and read the few framing headers directly.
 *
 * A callback that calls next passes anywhere but in the terminal route, where next would fall
 * out of the chain: there it only passes when the caller established that no later route
 * could catch the fall-through.
 *
 * @param {any[]} chain the routes the native handler runs, in order, this route last
 * @param {boolean} allowTerminalNext whether a fall-through past the chain lands only in the
 *   framework's own final handler
 * @returns {boolean}
 */
function chainSkipsHeaders(chain, allowTerminalNext) {
    for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        const callbacks = entry.callbacks;
        if (!Array.isArray(callbacks)) {
            return false;
        }
        const terminal = i === chain.length - 1;
        for (const cb of callbacks) {
            if (typeof cb !== "function") {
                return false;
            }
            const verdict = callbackSkipsHeaders(cb);
            if (verdict === NO || (verdict === SAFE_NEXT && terminal && !allowTerminalNext)) {
                return false;
            }
        }
        // a param callback runs code this walk never saw
        if (entry.paramCallbacks && entry.paramCallbacks.size > 0) {
            return false;
        }
    }
    return true;
}

module.exports = { chainSkipsHeaders, callbackSkipsHeaders, kGetSafe };
