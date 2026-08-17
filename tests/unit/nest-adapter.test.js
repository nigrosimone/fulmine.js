// fulmine.js/nest: the three things the adapter changes about @nestjs/platform-express.
//
// The end to end check, a whole Nest application answering the same bytes as one on Express, lives
// in integrations/cases/nest.js and needs Nest installed beside this project. This file is the
// unit of it: the adapter's own decisions, asserted where they are made.

require("reflect-metadata");
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { FulmineExpressAdapter } = require("../../src/nest.js");
const fulmine = require("../../src/index.js");

test("with no instance it builds a fulmine app, not an express one", () => {
    const adapter = new FulmineExpressAdapter();
    assert.ok(adapter.getInstance().uwsApp, "the instance should be one of ours");
});

test("the app is the server rather than being wrapped in one", () => {
    const app = fulmine();
    const adapter = new FulmineExpressAdapter(app);
    adapter.initHttpServer({});
    assert.strictEqual(adapter.getHttpServer(), app);
    // and it still answers as a server to everything that asks, which is what Nest goes on to use
    assert.ok(adapter.getHttpServer() instanceof http.Server);
});

test("httpsOptions is refused with the line to write instead", () => {
    const adapter = new FulmineExpressAdapter(fulmine());
    assert.throws(() => adapter.initHttpServer({ httpsOptions: { key: "x", cert: "y" } }), /uwsOptions/);
});

test("forceCloseConnections says it has nothing to destroy", () => {
    const adapter = new FulmineExpressAdapter(fulmine());
    const said = [];
    /** @type {any} */ (adapter).logger = { warn: (/** @type {string} */ line) => said.push(line) };
    adapter.initHttpServer({ forceCloseConnections: true });
    assert.strictEqual(said.length, 1);
    assert.match(said[0], /sockets belong to µWS/);
});

test("the body parsers go in once however often Nest asks for them", () => {
    const adapter = new FulmineExpressAdapter(fulmine());
    const added = [];
    /** @type {any} */ (adapter).use = (/** @type {any} */ fn) => added.push(fn.name);

    adapter.registerParserMiddleware();
    assert.deepStrictEqual(added, ["jsonParser", "urlencodedParser"]);

    // Nest calls this again on a second init, and on express the scan of app.router.stack would
    // find them and skip. There is no such array here, so the adapter remembers instead
    adapter.registerParserMiddleware();
    assert.deepStrictEqual(added, ["jsonParser", "urlencodedParser"]);
});

test("an unwrapped ExpressAdapter would have wrapped the instance in a node server", async () => {
    // the claim the adapter exists to make, asserted against the thing it replaces rather than
    // stated in a comment: a plain ExpressAdapter puts a node server in front of the app
    const { ExpressAdapter } = require("@nestjs/platform-express");
    const app = fulmine();
    const plain = new ExpressAdapter(app);
    plain.initHttpServer({});
    assert.notStrictEqual(plain.getHttpServer(), app);
    plain.getHttpServer().close();
});
