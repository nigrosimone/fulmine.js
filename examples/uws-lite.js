// app.uwsLite: a route served by uWS with an (req, res) handler, the part of Express most routes
// use over two small objects. About two times lighter than app.get(), and the same handler works
// on app.get() when a route needs more. The rest of the application stays Express.
//
//   node uws-lite.js
//   curl localhost:3000/users/42                    ->  {"id":"42","full":false}
//   curl 'localhost:3000/users/42?full=1'           ->  {"id":"42","full":true}
//   curl -X POST localhost:3000/users -d '{"name":"a"}'
//                                                   ->  201 {"id":1,"name":"a"}
//   curl -H 'x-api-key: secret' localhost:3000/orders/7
//                                                   ->  {"id":"7","account":"ann"}
//   curl localhost:3000/orders/7                    ->  401 {"error":"bad key"}
//   curl -X POST localhost:3000/audit -H 'authorization: ann' -d '{"a":1}'
//                                                   ->  {"by":"ann","body":{"a":1}}
//   curl localhost:3000/report --compressed         ->  id,total ... (chunked)
//   curl -X POST localhost:3000/size --data-binary @uws-lite.js
//                                                   ->  ... bytes
//   curl localhost:3000/health                      ->  ok (Express)
const { once } = require("node:events");
const { setTimeout: sleep } = require("node:timers/promises");
const express = require("fulmine.js"); // instead of require("express")

const app = express();

// query and params are ready, the handler answers as on Express
app.uwsLite.get("/users/:id", (req, res) => {
    res.json({ id: req.params.id, full: req.query.full === "1" });
});

// the body is read before the handler runs: over the limit is a 413, invalid JSON a 400
let users = 0;
app.uwsLite.post("/users", { body: "json", limit: "16kb" }, (req, res) => {
    res.status(201).json({ id: ++users, ...req.body });
});

// Middleware goes on the route, a route without it pays nothing. All the headers are kept for it.
const log = (req, res, next) => {
    const start = performance.now();
    res.on("finish", () => console.log(req.method, req.path, res.statusCode, performance.now() - start));
    next();
};
const apiKey = async (req, res, next) => {
    await sleep(1); // a lookup
    if (req.get("x-api-key") !== "secret") {
        return res.status(401).json({ error: "bad key" });
    }
    req.account = "ann";
    next();
};
const common = [log, apiKey];

app.uwsLite.get("/orders/:id", { use: common }, (req, res) => {
    res.json({ id: req.params.id, account: req.account });
});

// µWS's request is gone when the handler returns, and before it runs on a route with a body. What
// you read then is declared, here one header: it costs less than all of them
app.uwsLite.post("/audit", { body: "json", headers: ["authorization"] }, async (req, res) => {
    await sleep(1); // a write
    res.json({ by: req.get("authorization"), body: req.body });
});

// res is a writable: chunked, with backpressure, compressed if the client asks
app.uwsLite.get("/report", { compress: true }, async (req, res) => {
    res.type("text/csv");
    res.write("id,total\n");
    for (let id = 0; id < 10000; id++) {
        if (!res.write(`${id},${id * 2}\n`)) {
            await once(res, "drain");
        }
    }
    res.end();
});

// req.body is a Readable, there is no limit: you count what you read
app.uwsLite.post("/size", { body: "stream" }, async (req, res) => {
    let bytes = 0;
    for await (const chunk of req.body) {
        bytes += chunk.length;
    }
    res.send(`${bytes} bytes`);
});

// what lite does not have stays on an Express route: app.use(), req.ip, res.sendFile()...
app.use((req, res, next) => {
    console.log("express", req.method, req.url);
    next();
});
app.get("/health", (req, res) => res.send("ok"));

app.listen(3000, () => console.log("http://localhost:3000"));
