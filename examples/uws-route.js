// app.uws(): a route served by uWS itself, with the handler as written. It is called as
// (res, req) with uWS's own HttpResponse and HttpRequest, as a bare uWebSockets.js app would
// call it: no middleware, no Request, no Response. For the few routes where the Express API is
// not worth its cost; the rest of the application stays Express.
//
//   node uws-route.js
//   curl localhost:3000/health          ->  ok                 (raw)
//   curl localhost:3000/users/42        ->  {"id":"42"}        (raw)
//   curl localhost:3000/users/me        ->  {"id":"me"}        (raw: its pattern takes it first)
//   curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"name":"a"}'
//                                       ->  {"name":"a"}       (Express)
//   curl localhost:3000/slow?ms=200     ->  waited 200ms       (raw, answered late)
const express = require("fulmine.js"); // instead of require("express")

const app = express();

// no app.use() runs in front of a raw route: this logs the Express requests only
app.use((req, res, next) => {
    console.log("express", req.method, req.url);
    next();
});

// the whole answer in one call, as on uWS
app.uws("get", "/health", (res) => {
    res.end("ok");
});

// a parameter is uWS's: read by index, or by name, off uWS's request
app.uws("get", "/users/:id", (res, req) => {
    const id = req.getParameter(0) ?? "";
    res.writeStatus("200 OK").writeHeader("content-type", "application/json").end(JSON.stringify({ id }));
});

// written before the raw route or after it, this is never reached on GET: the raw pattern
// /users/:id takes /users/me first. `npx fulmine.js profile uws-route.js` says so
app.get("/users/me", (req, res) => res.json({ me: true }));

// another method on the same path is Express's
app.post("/users", express.json(), (req, res) => res.status(201).json(req.body));

// answering after the handler returns is the handler's business, as on uWS: read the request
// now, register onAborted, cork the late write
app.uws("get", "/slow", (res, req) => {
    const ms = Math.min(Number(req.getQuery("ms")) || 100, 2000);
    let aborted = false;
    res.onAborted(() => {
        aborted = true;
    });
    setTimeout(() => {
        if (aborted) return;
        res.cork(() => {
            res.writeStatus("200 OK").end(`waited ${ms}ms`);
        });
    }, ms);
});

app.listen(3000, () => {
    console.log("http://localhost:3000/health");
});
