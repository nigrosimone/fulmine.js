// send() with nothing after the head is out answers, unless the status strips headers: express
// strips them through removeHeader, and node refuses that once the head has gone out

// Fuzzer seed 2482457356: writeHead(202), status(204), send(req.body) with no body parser, so
// send(undefined). Express throws ERR_HTTP_HEADERS_SENT out of removeHeader and its final handler
// drops the connection; we answered 202. The same for 304, for a fresh request, and for 205,
// which sets Content-Length instead.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("env", "test");

app.get("/plain", (req, res) => {
    res.writeHead(202, { "X-W": "r7" });
    res.send();
});
app.get("/no-content", (req, res) => {
    res.writeHead(202, { "X-W": "r7" });
    res.status(204);
    res.send(undefined);
});
app.get("/not-modified", (req, res) => {
    res.write("partial");
    res.status(304);
    res.send();
});
app.get("/reset", (req, res) => {
    res.writeHead(200);
    res.status(205);
    res.send();
});
app.get("/fresh", (req, res) => {
    res.set("ETag", '"v1"');
    res.writeHead(200);
    res.send();
});

app.listen(13333, async () => {
    const urls = [
        ["/plain", {}],
        ["/no-content", {}],
        ["/not-modified", {}],
        ["/reset", {}],
        // max-age, or fetch adds a cache-control: no-cache of its own and nothing is fresh
        ["/fresh", { headers: { "if-none-match": '"v1"', "cache-control": "max-age=604800" } }],
        ["/fresh", {}]
    ];
    for (const [path, init] of urls) {
        try {
            const res = await fetchTest("http://localhost:13333" + path, {
                ...init,
                signal: AbortSignal.timeout(3000)
            });
            console.log(path, res.status, JSON.stringify(await res.text()));
        } catch (e) {
            console.log(path, "fetch failed:", e.name, e.cause?.code ?? e.cause?.message ?? e.message);
        }
    }
    process.exit(0);
});
