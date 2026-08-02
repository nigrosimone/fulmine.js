// must support req.fresh and req.stale

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// Counted rather than logged as they happen. The five requests below go out at once, and a log
// written when a response finishes lands among the lines the client prints for the others, in an
// order that depends on which response came back first: the helper orders the client's own lines
// and can do nothing about a second source. On this machine it happened to be stable, and on CI it
// was not. The counts say the same thing at a fixed point, and say a little more besides, since
// close following finish is what actually has to hold.
let finished = 0;
let closed = 0;
let closedAfterFinish = 0;

app.get("/test", (req, res) => {
    let sawFinish = false;
    res.once("finish", () => {
        sawFinish = true;
        finished++;
    });
    res.once("close", () => {
        closed++;
        if (sawFinish) closedAfterFinish++;
    });
    res.set("ETag", '"123"');
    res.send([req.fresh, req.stale]);
});

// fixed, not new Date(): the handler sends it as Last-Modified and the test prints the header, so
// reading the clock would make the two runs differ by a second for no reason of the framework's.
const date = new Date("2024-03-05T10:20:30.000Z");

app.get("/test2", (req, res) => {
    res.set("Etag", '"1234"');
    res.set("last-modified", date.toISOString());
    res.send([req.fresh, req.stale]);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await Promise.all([
        fetchTest("http://localhost:13333/test", {
            headers: {
                "cache-control": "max-age=604800"
            }
        }),
        fetchTest("http://localhost:13333/test", {
            headers: {
                "cache-control": "max-age=604800",
                "if-none-match": '"123"'
            }
        }),
        fetchTest("http://localhost:13333/test", {
            headers: {
                "cache-control": "max-age=604800",
                "if-none-match": '"1234"'
            }
        }),
        fetchTest("http://localhost:13333/test2", {
            headers: {
                "cache-control": "max-age=604800"
            }
        }),
        fetchTest("http://localhost:13333/test2", {
            headers: {
                "cache-control": "max-age=604800",
                "if-modified-since": new Date(date.getTime() - 1000).toISOString()
            }
        })
    ]);

    const texts = await Promise.all(responses.map((res) => res.text()));

    console.log(
        texts,
        responses.map((res) => res.status)
    );
    console.log("finish:", finished, "close:", closed, "close after finish:", closedAfterFinish);

    process.exit(0);
});
