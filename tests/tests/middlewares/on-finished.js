// must support on-finished
// INSPECT
//
// The other half of the pair: it hears when the response is done or the connection went away, which
// is how morgan writes its line and how anything that holds a resource lets go of it. It listens on
// the response and reads its socket, so it is a good check that both look the way node's do at the
// moment they finish.

const express = require("express");
const onFinished = require("on-finished");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// what the listener saw, reported by the next request rather than by this one, since it runs after
// the response has gone
const seen = [];

app.get("/simple", (req, res) => {
    onFinished(res, (err) => {
        seen.push({ where: "simple", err: err === null || err === undefined ? "none" : String(err.message) });
    });
    res.send("body");
});

app.get("/status-at-finish", (req, res) => {
    onFinished(res, (err, response) => {
        // the response is handed back, and it still answers for what was sent
        seen.push({ where: "status-at-finish", status: response.statusCode, same: response === res });
    });
    res.status(201).send("created");
});

// isFinished before and after, which is the question a caller asks to decide whether to bother
app.get("/is-finished", (req, res) => {
    const before = onFinished.isFinished(res);
    onFinished(res, () => {
        seen.push({ where: "is-finished", before, after: onFinished.isFinished(res) });
    });
    res.send("body");
});

// the request side of the same hook, which is what a body reader uses to know it can stop
app.post("/request", express.json(), (req, res) => {
    onFinished(req, () => {
        seen.push({ where: "request", body: JSON.stringify(req.body) });
    });
    res.send("read");
});

app.get("/seen", (req, res) => res.json(seen));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/simple", "/status-at-finish", "/is-finished"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }
    const posted = await fetchTest("http://localhost:13333/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" })
    });
    console.log("/request", posted.status, await posted.text());

    // one more round trip, so every listener above has had its turn before this is read
    const report = await fetchTest("http://localhost:13333/seen");
    console.log("/seen", report.status, await report.text());

    process.exit(0);
});
