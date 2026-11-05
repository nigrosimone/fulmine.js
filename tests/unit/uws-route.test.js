// app.uws(), which has no Express counterpart and so cannot be a comparison test: the handler is
// µWS's own (res, req), with nothing of Express in front of it. What is pinned is the contract the
// docs promise: the handler is handed µWS's objects untouched, no middleware runs for it, it
// answers before the Express routes on every path its pattern takes whichever was written first,
// the Express routes it does not take stay native, mounted routers compose their paths, a route
// added after listen() is served, and a call that cannot work is refused where it is written.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const express = require("../../src/index.js");

/**
 * Starts an app and answers its port plus a close helper.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{app: any, port: number, close: () => Promise<void>}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({
                app,
                port: app.address().port,
                close: () => new Promise((done) => app.close(() => done()))
            });
        });
    });
}

/**
 * One request, answered as status and body.
 *
 * @param {number} port
 * @param {string} path
 * @param {string} [method]
 * @returns {Promise<{status: number, body: string, headers: Headers}>}
 */
async function ask(port, path, method = "GET") {
    const res = await fetch(`http://localhost:${port}${path}`, { method });
    return { status: res.status, body: await res.text(), headers: res.headers };
}

test("the handler gets µWS's own response and request, and no middleware runs", async () => {
    let middleware = 0;
    const { port, close } = await serve((app) => {
        app.use((req, res, next) => {
            middleware++;
            next();
        });
        app.uws("get", "/raw/:id", (res, req) => {
            // µWS's HttpRequest and HttpResponse, not this project's Request and Response
            assert.equal(typeof req.getParameter, "function");
            assert.equal(typeof res.writeStatus, "function");
            assert.equal(res.req, undefined);
            const body = [req.getMethod(), req.getUrl(), req.getQuery(), req.getParameter(0), req.getHeader("x-a")];
            res.writeStatus("202 Accepted").writeHeader("x-raw", "yes").end(body.join("|"));
        });
        app.get("/express", (req, res) => res.send("express"));
    });

    const res = await fetch(`http://localhost:${port}/raw/42?q=1`, { headers: { "x-a": "b" } });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("x-raw"), "yes");
    // µWS sends no x-powered-by and no content-type of its own
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(await res.text(), "get|/raw/42|q=1|42|b");
    assert.equal(middleware, 0);

    assert.equal((await ask(port, "/express")).body, "express");
    assert.equal(middleware, 1);
    await close();
});

test("it answers before the Express routes its pattern takes, written before or after them", async () => {
    const { app, port, close } = await serve((app) => {
        app.set("etag", false);
        // a literal µWS would prefer to the parameter, on its own native registration
        app.get("/users/me", (req, res) => res.send("express me"));
        app.uws("get", "/users/:id", (res, req) => res.end("raw " + req.getParameter(0)));
        app.get("/users/admin", (req, res) => res.send("express admin"));
        // another method and another length are not the µWS route's
        app.post("/users/:id", (req, res) => res.send("express post"));
        app.get("/users/:id/posts", (req, res) => res.send("express posts"));
        app.get("/other", (req, res) => res.send("express other"));
    });

    assert.equal((await ask(port, "/users/1")).body, "raw 1");
    assert.equal((await ask(port, "/users/me")).body, "raw me");
    assert.equal((await ask(port, "/users/admin")).body, "raw admin");
    assert.equal((await ask(port, "/users/1", "POST")).body, "express post");
    assert.equal((await ask(port, "/users/1/posts")).body, "express posts");
    assert.equal((await ask(port, "/other")).body, "express other");
    // µWS matches bytes: another case is not the µWS route's, and Express answers it
    assert.equal((await ask(port, "/USERS/me")).body, "express me");

    // the routes it takes stay off µWS's table and say why, the rest are still native
    const report = express.testing.routeReport(app);
    const why = (method, path) => report.find((r) => r.method === method && r.path === path);
    assert.equal(why("GET", "/users/me").native, false);
    assert.match(why("GET", "/users/me").reason, /app\.uws\("get", "\/users\/:id"\)/);
    assert.equal(why("GET", "/users/admin").native, false);
    express.testing.expectNative(app, ["POST /users/:id", "/users/:id/posts", "/other"]);
    await close();
});

test("a HEAD is not a GET route's: Express answers it", async () => {
    const { port, close } = await serve((app) => {
        app.uws("get", "/page", (res) => res.end("raw"));
        app.get("/page", (req, res) => res.send("express"));
    });
    assert.equal((await ask(port, "/page")).body, "raw");
    const head = await ask(port, "/page", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
    await close();
});

test("a trailing slash is a path of its own, and the non-strict twin stays off the table", async () => {
    const { port, close } = await serve((app) => {
        app.set("etag", false);
        app.get("/a", (req, res) => res.send("express"));
        app.uws("get", "/a/", (res) => res.end("raw"));
    });
    assert.equal((await ask(port, "/a")).body, "express");
    assert.equal((await ask(port, "/a/")).body, "raw");
    await close();
});

test("any, and a wildcard on /*, take every method and path from the catch-all", async () => {
    const { port, close } = await serve((app) => {
        app.get("/", (req, res) => res.send("express"));
        app.use((req, res) => res.status(404).send("express 404"));
        app.uws("any", "/*", (res, req) => res.end("raw " + req.getMethod() + " " + req.getUrl()));
    });
    assert.equal((await ask(port, "/")).body, "raw get /");
    assert.equal((await ask(port, "/x/y", "DELETE")).body, "raw delete /x/y");
    await close();
});

test("a mounted router composes its path, and a route added after listen() is served", async () => {
    const { app, port, close } = await serve((app) => {
        const api = express.Router();
        api.uws("delete", "/items/:id", (res, req) => res.end("raw delete " + req.getParameter(0)));
        api.get("/items/:id", (req, res) => res.send("express get " + req.params.id));
        app.use("/api", api);
    });
    assert.equal((await ask(port, "/api/items/7", "DELETE")).body, "raw delete 7");
    assert.equal((await ask(port, "/api/items/7")).body, "express get 7");
    assert.equal((await ask(port, "/items/7", "DELETE")).status, 404);

    app.uws("get", "/late", (res) => res.end("raw late"));
    assert.equal((await ask(port, "/late")).body, "raw late");
    await close();
});

test("an asynchronous answer is the handler's to cork and to abort, as on µWS", async () => {
    let aborted = false;
    const { port, close } = await serve((app) => {
        app.uws("post", "/echo", (res) => {
            const chunks = [];
            res.onAborted(() => {
                aborted = true;
            });
            res.onData((chunk, isLast) => {
                // µWS neuters the chunk when the callback returns, so it is copied
                chunks.push(Buffer.from(new Uint8Array(chunk)));
                if (isLast) {
                    setImmediate(() => {
                        if (!aborted) res.cork(() => res.end("got " + Buffer.concat(chunks).toString()));
                    });
                }
            });
        });
    });
    const res = await fetch(`http://localhost:${port}/echo`, { method: "POST", body: "payload" });
    assert.equal(await res.text(), "got payload");
    assert.equal(aborted, false);
    await close();
});

test("express.uWS is the µWS this project serves with, and getParts() splits a body in a route", async () => {
    // the same instance, not a second copy of the binary
    assert.equal(express.uWS, require("uWebSockets.js"));
    // not enumerable, so copying the namespace does not load it, and not a named ESM export
    assert.equal(Object.keys(express).includes("uWS"), false);

    const { getParts } = express.uWS;
    const { port, close } = await serve((app) => {
        app.uws("post", "/upload", (res, req) => {
            // read before returning: µWS's request is gone afterwards
            const contentType = req.getHeader("content-type");
            let aborted = false;
            res.onAborted(() => {
                aborted = true;
            });
            const chunks = [];
            res.onData((chunk, isLast) => {
                chunks.push(Buffer.from(new Uint8Array(chunk)));
                if (!isLast || aborted) return;
                const parts = getParts(Buffer.concat(chunks), contentType) ?? [];
                const seen = parts.map((p) => `${p.name}=${p.filename ?? ""}:${p.type ?? ""}:${Buffer.from(p.data)}`);
                res.cork(() => res.end(seen.join("|")));
            });
        });
    });

    const form = new FormData();
    form.append("title", "hello");
    form.append("file", new Blob(["file body"], { type: "text/plain" }), "a.txt");
    const res = await fetch(`http://localhost:${port}/upload`, { method: "POST", body: form });
    assert.equal(await res.text(), "title=::hello|file=a.txt:text/plain:file body");
    await close();
});

test("a DeclarativeResponse is a route of its own, as µWS takes it", async () => {
    const { port, close } = await serve((app) => {
        app.uws(
            "get",
            "/compiled/:id",
            new express.uWS.DeclarativeResponse()
                .writeStatus("200 OK")
                .writeHeader("x-compiled", "yes")
                .write("id ")
                .writeParameterValue("id")
                .end("")
        );
    });
    const res = await ask(port, "/compiled/9");
    assert.equal(res.body, "id 9");
    assert.equal(res.headers.get("x-compiled"), "yes");
    await close();
});

test("a call that cannot work is refused where it is written", () => {
    const app = express();
    assert.throws(() => app.uws("fetch", "/x", () => {}), /method must be one of/);
    assert.throws(() => app.uws(undefined, "/x", () => {}), /method must be one of/);
    assert.throws(() => app.uws("get", "x", () => {}), /path string starting with \//);
    assert.throws(() => app.uws("get", /x/, () => {}), /path string/);
    assert.throws(() => app.uws("get", "/x"), /handler function/);
    assert.throws(() => app.uws("get", "/x", "hello"), /handler function/);
    assert.equal(
        app.uws("GET", "/x", () => {}),
        app
    );
});

test("under a mount µWS cannot match it is refused at listen(), rather than never served", () => {
    const app = express();
    const router = express.Router();
    router.uws("get", "/x", (res) => res.end("x"));
    app.use(/^\/v\d+/, router);
    assert.throws(() => app.listen(0), /sits under a mount µWS cannot match/);
});

test("the node shim serves the Express routes and leaves the µWS route unserved", async () => {
    const app = express();
    app.uws("get", "/raw", (res) => res.end("raw"));
    app.get("/express", (req, res) => res.send("express"));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    assert.equal((await ask(port, "/express")).body, "express");
    assert.equal((await ask(port, "/raw")).status, 404);
    await new Promise((resolve) => server.close(resolve));
});

test("each method has its verb, as app.get(), and the call with the method stays", async () => {
    const server = await serve((app) => {
        const answer = (name) => (res) => res.end(name);
        const back = app.uws.get("/verb", answer("get"));
        assert.strictEqual(back, app);
        app.uws
            .post("/verb", answer("post"))
            .uws.put("/verb", answer("put"))
            .uws.patch("/verb", answer("patch"))
            .uws.delete("/verb", answer("delete"))
            .uws.del("/del", answer("del"))
            .uws.options("/verb", answer("options"))
            .uws.any("/any", answer("any"))
            .uws.all("/all", answer("all"));
        app.uws("get", "/called", answer("called"));
        const router = express.Router();
        router.uws.get("/ping", answer("router"));
        app.use("/api", router);
    });
    try {
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
            assert.strictEqual((await ask(server.port, "/verb", method)).body, method.toLowerCase());
        }
        assert.strictEqual((await ask(server.port, "/del", "DELETE")).body, "del");
        assert.strictEqual((await ask(server.port, "/any", "PUT")).body, "any");
        assert.strictEqual((await ask(server.port, "/all", "PUT")).body, "all");
        assert.strictEqual((await ask(server.port, "/called")).body, "called");
        assert.strictEqual((await ask(server.port, "/api/ping")).body, "router");
    } finally {
        await server.close();
    }
});

test("a verb after listen goes straight to µWS, as the call with the method", async () => {
    const server = await serve(() => {});
    try {
        server.app.uws.get("/late", (res) => res.end("late"));
        assert.strictEqual((await ask(server.port, "/late")).body, "late");
    } finally {
        await server.close();
    }
});

test("a verb checks its arguments as the call with the method does", () => {
    const app = express();
    assert.throws(() => app.uws.get("no-slash", () => {}), /path string starting with \//);
    assert.throws(() => app.uws.get("/x"), /requires a handler function/);
    assert.strictEqual(app.uws.bind, Function.prototype.bind);
});
