// types-surface.test.js asks whether everything this project adds is declared. This asks the
// opposite question, which is the one that costs an application a 500: what does Express carry that
// is not here at all. `req.socket.setTimeout` was missing for months, n8n's chat trigger calls it on
// every webhook it serves, and the TypeError came back as "Workflow could not be started!" with the
// cause swallowed by their error handler. Nothing in this repo could have said the method was gone.
//
// Both arms serve one request and are asked what the request, the response and the socket carry:
// Express through node's own server, this project through µWS. What Express has and this does not
// is a gap, and every gap has to be written down below with the reason it is one. A gap that closes
// fails here too, so the list cannot rot: it says what is missing today, not what was missing when
// somebody last looked.

const test = require("node:test");
const assert = require("node:assert");

const fulmine = require("../../src/index.js");
const express = require("express");

/**
 * Every property name reachable on an object, its prototype chain included. Node's own private
 * members are left out: an application that reaches for one has left the public surface.
 *
 * @param {any} object
 * @returns {Set<string>}
 */
function members(object) {
    const names = new Set();
    for (let o = object; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
        for (const name of Object.getOwnPropertyNames(o)) {
            if (!name.startsWith("_")) names.add(name);
        }
    }
    return names;
}

/**
 * Serves one request and reports what the three objects carried while it ran.
 *
 * @param {any} framework
 * @returns {Promise<{request: Set<string>, response: Set<string>, socket: Set<string>}>}
 */
async function surfaceOf(framework) {
    const app = framework();
    /** @type {any} */
    let seen;
    app.post("/surface", (req, res) => {
        seen = { request: members(req), response: members(res), socket: members(req.socket) };
        res.end("ok");
    });
    const server = await new Promise((done) => {
        const started = app.listen(0, () => done(started));
    });
    const port = (server.address ? server.address() : app.address()).port;
    await fetch(`http://127.0.0.1:${port}/surface`, {
        method: "POST",
        body: "x",
        headers: { "content-type": "text/plain" }
    });
    await new Promise((done) => server.close(() => done()));
    return seen;
}

// What Express has here and this project does not. Everything in this object is a known hole, not
// an approved one: closing any of them is welcome, and doing so fails this test until the name is
// taken out.
const GAPS = {
    request: new Set([
        // node's, and reachable: an application does read them. req.aborted is deprecated in node
        // but still read by middleware, and `upgrade` is what on-finished looks at first
        "aborted",
        "upgrade",
        // an IncomingMessage carries these for a client response and leaves them null on a server
        // request, so what is missing is two nulls
        "statusCode",
        "statusMessage",
        // the pre-node-0.12 name for socket, deprecated for a decade
        "client",
        // trailers arrive after the body and µWS does not hand them over
        "rawTrailers",
        // a flag of node's parser, set from a server option this project does not take
        "joinDuplicateHeaders"
    ]),
    response: new Set([
        // how node frames what it writes. µWS frames the response itself, so there is nothing here
        // to read or to set
        "chunkedEncoding",
        "shouldKeepAlive",
        "useChunkedEncodingByDefault",
        "strictContentLength",
        "outputData",
        "outputSize",
        "maxRequestsOnConnectionReached",
        // node adds the Date header unless this is turned off. It is added here always
        "sendDate",
        // 1xx informational responses, which µWS cannot send
        "writeInformation",
        // node's own deprecated alias for writeHead, gone in node 26 and still there on 22 and 24
        "writeHeader"
    ]),
    socket: new Set([
        // req.socket and res.socket are one stand-in, an EventEmitter with the address, the ports,
        // the tuning methods and the few things an application really calls: destroy, pause,
        // resume, write, end, address, ref. What is left below is the stream underneath, which µWS
        // owns and does not hand over: the buffers and their counters, the reading half, the
        // iteration helpers node's streams grew, and the handles to the parser and the server.
        // Nothing here can be answered with anything better than a lie.
        "allowHalfOpen",
        "bufferSize",
        "bytesRead",
        "bytesWritten",
        "closed",
        "compose",
        "connect",
        "cork",
        "drop",
        "errored",
        "every",
        "filter",
        "find",
        "flatMap",
        "forEach",
        "getTypeOfService",
        "isPaused",
        "iterator",
        "localAddress",
        "localFamily",
        "map",
        "parser",
        "pipe",
        "push",
        "read",
        "readableAborted",
        "readableBuffer",
        "readableDidRead",
        "readableEncoding",
        "readableEnded",
        "readableFlowing",
        "readableHighWaterMark",
        "readableLength",
        "readableObjectMode",
        "reduce",
        "resetAndDestroy",
        "server",
        "setDefaultEncoding",
        "setEncoding",
        "setTypeOfService",
        "some",
        "take",
        "toArray",
        "uncork",
        "unpipe",
        "unshift",
        "wrap",
        "writableBuffer",
        "writableCorked",
        "writableEnded",
        "writableFinished",
        "writableHighWaterMark",
        "writableLength",
        "writableNeedDrain",
        "writableObjectMode"
    ])
};

test("nothing Express carries goes missing here without being written down", async () => {
    const reference = await surfaceOf(express);
    const ours = await surfaceOf(fulmine);

    /** @type {Record<string, string[]>} */
    const unlisted = {};
    /** @type {Record<string, string[]>} */
    const closed = {};
    for (const kind of ["request", "response", "socket"]) {
        const missing = [...reference[kind]].filter((name) => !ours[kind].has(name));
        unlisted[kind] = missing.filter((name) => !GAPS[kind].has(name)).sort();
        // and the other way, so the list says what is missing now rather than what once was. Only
        // names Express still carries on the node running this: a member node has dropped since,
        // writeHeader on 26 for one, is out of the comparison rather than a gap that closed
        closed[kind] = [...GAPS[kind]].filter((name) => reference[kind].has(name) && !missing.includes(name)).sort();
    }

    assert.deepStrictEqual(unlisted, { request: [], response: [], socket: [] });
    assert.deepStrictEqual(closed, { request: [], response: [], socket: [] });
});

/**
 * The objects code reaches through the router instead of the request: the module, the app, a
 * Router, the Route app.route() hands back, the layers of the three stacks and req.route. Colyseus
 * asks app.router.stack[i].match("/"), route listers call layer.matchers[0].
 *
 * @param {any} framework
 * @returns {Promise<Record<string, Set<string>>>}
 */
async function routerSurfaceOf(framework) {
    const app = framework();
    const router = framework.Router();
    router.get("/x", function inner(req, res) {
        res.end();
    });
    app.use(function pathless(req, res, next) {
        next();
    });
    app.use("/mounted", router);
    /** @type {any} */
    let seenRoute;
    app.get("/route/:id", function seen(req, res) {
        seenRoute = req.route;
        res.end("ok");
    });
    const route = app.route("/chained").get(function chained(req, res) {
        res.end();
    });
    const stack = app.router.stack;
    const server = await new Promise((done) => {
        const started = app.listen(0, () => done(started));
    });
    const port = (server.address ? server.address() : app.address()).port;
    await fetch(`http://127.0.0.1:${port}/route/1`);
    await new Promise((done) => server.close(() => done()));
    // req.route is the Route in express and the route's record here: its fields are compared, not
    // the verb methods express's Route carries for registering, which nobody calls on req.route
    const fields = new Set([...members(seenRoute)].filter((name) => typeof seenRoute[name] !== "function"));
    return {
        exports: members(framework),
        app: members(app),
        router: members(router),
        Router: members(framework.Router),
        route: members(route),
        useLayer: members(stack.find((/** @type {any} */ l) => l.name === "pathless")),
        mountLayer: members(stack.find((/** @type {any} */ l) => l.name === "router")),
        routeLayer: members(stack.find((/** @type {any} */ l) => l.route)),
        routeStackLayer: members(route.stack[0]),
        reqRoute: fields
    };
}

// What Express has there and this project does not, each with the reason
/** @type {Record<string, Set<string>>} */
const ROUTER_GAPS = {
    exports: new Set(),
    // they reset an app to its defaults: express calls them once from createApplication, an
    // application never does
    app: new Set(["defaultConfiguration", "init"]),
    router: new Set(),
    Router: new Set(),
    route: new Set(),
    useLayer: new Set(),
    mountLayer: new Set(),
    routeLayer: new Set(),
    routeStackLayer: new Set(),
    reqRoute: new Set()
};

test("nothing Express carries on the router and its layers goes missing without being written down", async () => {
    const reference = await routerSurfaceOf(express);
    const ours = await routerSurfaceOf(fulmine);

    /** @type {Record<string, string[]>} */
    const unlisted = {};
    /** @type {Record<string, string[]>} */
    const closed = {};
    for (const kind of Object.keys(ROUTER_GAPS)) {
        const missing = [...reference[kind]].filter((name) => !ours[kind].has(name));
        unlisted[kind] = missing.filter((name) => !ROUTER_GAPS[kind].has(name)).sort();
        closed[kind] = [...ROUTER_GAPS[kind]].filter((name) => !missing.includes(name)).sort();
    }
    const none = Object.fromEntries(Object.keys(ROUTER_GAPS).map((kind) => [kind, []]));
    assert.deepStrictEqual(unlisted, none);
    assert.deepStrictEqual(closed, none);
});
