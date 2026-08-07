// must support morgan middleware
// INSPECT
//
// The log line is what this middleware is for, so it is written to a stream of its own and printed,
// rather than left on stdout where the suite could not compare it. Everything that changes between
// two runs, a duration and a date, is replaced before printing.

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const morgan = require("morgan");

const app = express();
app.set("etag", false);

const lines = [];
/** Collects what morgan writes, with the volatile parts taken out. */
const stream = {
    write(line) {
        lines.push(
            line
                .replace(/\d+\.\d+ ms/g, "<duration> ms")
                .replace(/\d+\.\d+/g, "<number>")
                .replace(/\[[^\]]+\]/g, "[<date>]")
                .trimEnd()
        );
    }
};

// a token of one's own, which is how an application adds what it needs to the line
morgan.token("greeting", (req) => String(req.headers["x-greeting"] ?? "none"));

app.use(
    morgan(":method :url :status :res[content-length] :greeting", {
        stream,
        // the health check is not worth a line, which is what skip is for
        skip: (req) => req.path === "/health"
    })
);

// a second logger, in immediate mode, which writes before the handler rather than after it
app.use(morgan("immediate :method :url", { stream, immediate: true }));

app.get("/", (req, res) => res.send("hello, world!"));
app.get("/health", (req, res) => res.send("ok"));
app.get("/missing", (req, res) => res.status(404).send("nope"));
app.post("/echo", express.json(), (req, res) => res.json(req.body));

app.get("/lines", (req, res) => res.json(lines));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    console.log(await fetchTest("http://localhost:13333/").then((res) => res.text()));
    console.log(await fetchTest("http://localhost:13333/health").then((res) => res.text()));
    console.log(await fetchTest("http://localhost:13333/missing").then((res) => res.text()));
    console.log(
        await fetchTest("http://localhost:13333/", { headers: { "x-greeting": "ciao" } }).then((res) => res.text())
    );
    console.log(
        await fetchTest("http://localhost:13333/echo", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: 1 })
        }).then((res) => res.text())
    );

    // and what morgan wrote for all of it, which is the thing under test
    const written = await fetchTest("http://localhost:13333/lines").then((res) => res.json());
    for (const line of written) {
        console.log("log:", line);
    }

    process.exit(0);
});
