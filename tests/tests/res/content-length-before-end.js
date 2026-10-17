// Content-Length as a middleware sees it while the response goes out
//
// express's send() puts it in the headers before end(), so an end wrapper (express-winston), an
// on-headers hook (compression, response-time) and a finish listener (morgan) all read it. A plain
// res.end() puts none there, as node. Fulmine set it only at the very end, and for any end().

const express = require("express");
const onHeaders = require("on-headers");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
/** @type {string[]} */
const seen = [];

app.use((req, res, next) => {
    const end = res.end;
    res.end = function (...args) {
        seen.push(
            `${req.method} ${req.url} end: ${res.getHeader("content-length")} ${res.hasHeader("content-length")}`
        );
        return end.apply(this, args);
    };
    onHeaders(res, () => {
        seen.push(
            `${req.method} ${req.url} headers: ${res.getHeader("content-length")} ${res.hasHeader("content-length")}`
        );
        // compression drops it when it compresses, and it has to stay dropped
        if (req.query.drop) {
            res.removeHeader("Content-Length");
            seen.push(`${req.method} ${req.url} dropped: ${res.getHeader("content-length")}`);
        }
    });
    res.on("finish", () => seen.push(`${req.method} ${req.url} finish: ${res.getHeader("content-length")}`));
    next();
});

app.get("/string", (req, res) => res.send("hello"));
app.get("/unicode", (req, res) => res.send("caffè ☕"));
app.get("/json", (req, res) => res.json({ a: 1 }));
app.get("/buffer", (req, res) => res.send(Buffer.alloc(12)));
app.get("/null", (req, res) => res.send(null));
app.get("/status", (req, res) => res.sendStatus(204));
app.get("/reset", (req, res) => res.status(205).send("ignored"));
app.get("/end", (req, res) => res.end("raw"));
app.get("/chunked", (req, res) => res.set("Transfer-Encoding", "chunked").send("framed"));
app.get("/preset", (req, res) => res.set("Content-Length", "99").send("short"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const requests = [
        ["GET", "/string"],
        ["GET", "/string?drop=1"],
        ["HEAD", "/string"],
        ["GET", "/unicode"],
        ["GET", "/json"],
        ["GET", "/buffer"],
        ["GET", "/null"],
        ["GET", "/status"],
        ["GET", "/reset"],
        ["GET", "/end"],
        ["GET", "/chunked"],
        ["GET", "/preset"]
    ];
    const answers = await sequential(
        requests.map(([method, path]) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`, { method });
            const text = await res.text();
            // after the hook drops it the framing is the server's own: node chunks, uWS writes a length
            const length = path.includes("drop") ? "" : res.headers.get("content-length");
            return `${method} ${path} wire: ${res.status} ${length} ${JSON.stringify(text)}`;
        })
    );
    // a conditional request: send() makes it a 304 after setting the length, and then drops it
    const tag = (await fetchTest("http://localhost:13333/string")).headers.get("etag");
    const fresh = await fetchTest("http://localhost:13333/string", { headers: { "If-None-Match": tag } });
    answers.push(`conditional wire: ${fresh.status} ${fresh.headers.get("content-length")}`);

    console.log(seen.join("\n"));
    console.log(answers.join("\n"));
    process.exit(0);
});
