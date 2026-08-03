// must serve a request that arrived through node's own HTTP server

const express = require("express");
const http = require("http");
const path = require("path");

// The app is handed to http.createServer, which is what supertest does behind request(app) and what
// anyone composing servers by hand writes. Express is a request listener already; this one is built
// on uWS and answers node's IncomingMessage through a shim, so this file is about the two agreeing.
const app = express();

app.use(express.json());
app.get("/hello", (req, res) => res.send(`hello ${req.query.name || "world"}`));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id, path: req.path }));
app.post("/echo", (req, res) => res.json({ got: req.body }));
app.get("/teapot", (req, res) => res.status(418).type("html").send("<b>teapot</b>"));
app.get("/file", (req, res) => res.sendFile(path.join(process.cwd(), "tests/parts/small-file.json")));
app.get("/custom-header", (req, res) => {
    res.set("X-Custom", "value");
    res.send("with a header");
});
// two cookies, which is a header written twice rather than a header written once. uWS writes a line
// per call and node's setHeader replaces, so the shim has to append or one of these disappears
app.get("/cookies", (req, res) => {
    res.cookie("first", "1");
    res.append("Set-Cookie", "second=2");
    res.send("two cookies");
});
app.use((req, res) => res.status(404).send("nothing here"));

const server = http.createServer(app);

server.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cases = [
        ["GET", "/hello?name=simone"],
        ["GET", "/users/42"],
        ["POST", "/echo"],
        ["GET", "/teapot"],
        ["GET", "/custom-header"],
        ["GET", "/cookies"],
        ["GET", "/file"],
        ["HEAD", "/hello"],
        // the automatic OPTIONS reply, which a request served this way has to get as well
        ["OPTIONS", "/hello"],
        ["GET", "/nowhere"]
    ];

    for (const [method, route] of cases) {
        const response = await fetch(base + route, {
            method,
            headers: method === "POST" ? { "content-type": "application/json" } : {},
            body: method === "POST" ? JSON.stringify({ a: 1, b: [2, 3] }) : undefined
        });
        const body = await response.text();
        console.log(
            method,
            route,
            response.status,
            JSON.stringify(response.headers.get("content-type")),
            JSON.stringify(response.headers.get("x-custom")),
            JSON.stringify(response.headers.getSetCookie()),
            JSON.stringify(response.headers.get("allow")),
            // the body of the file is long and its bytes are asserted elsewhere
            JSON.stringify(route === "/file" ? body.length : body)
        );
    }

    server.close();
    process.exit(0);
});
