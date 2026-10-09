// an error handler is read like a route: one that reads a header, or calls next() into a route
// that does, keeps the header copy for the whole app; one that reads req.url keeps the query

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const PROBE = { headers: { "x-probe": "seen" } };

// reads nothing the skip drops but the query
const plain = express();
plain.set("env", "production");
plain.get("/throw", () => {
    throw new Error("thrown");
});
plain.get("/next", (req, res, next) => next(new Error("nexted")));
plain.get("/ok", (req, res) => res.send("ok " + req.path));
plain.use((err, req, res, next) => res.status(500).send(`${req.method} ${req.url} ${err.message}`));

// the second error handler reads a header
const reads = express();
reads.set("env", "production");
reads.get("/throw", () => {
    throw new Error("thrown");
});
reads.use((err, req, res, next) => next(err));
reads.use((err, req, res, next) => res.status(500).send(`probe ${req.get("x-probe")}`));

// the error handler resumes the routes, and a later middleware reads a header
const resumes = express();
resumes.set("env", "production");
resumes.get("/throw", () => {
    throw new Error("thrown");
});
resumes.use((err, req, res, next) => next());
resumes.use((req, res) => res.send(`resumed ${req.get("x-probe")}`));

const show = async (/** @type {string} */ url) => {
    const res = await fetchTest(url, PROBE);
    console.log(url.slice(url.indexOf("/", 7)), res.status, await res.text());
};

plain.listen(13333, () =>
    reads.listen(13334, () =>
        resumes.listen(13335, async () => {
            await sequential(
                [
                    "http://localhost:13333/throw?x=1",
                    "http://localhost:13333/next?y=2",
                    "http://localhost:13333/ok?z=3",
                    "http://localhost:13334/throw",
                    "http://localhost:13335/throw"
                ].map((url) => () => show(url))
            );
            process.exit(0);
        })
    )
);
