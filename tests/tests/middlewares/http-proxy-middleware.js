// must support http-proxy-middleware
// INSPECT
process.env.DEBUG = "http-proxy-middleware";

const express = require("express");
const http = require("http");
const { fetchTest } = require("../../helpers.js");

const { createProxyMiddleware } = require("http-proxy-middleware");

// A server of ours is the target, not something on the internet. This proxied to api.github.com,
// and a rate limit or a changed field would answer the two runs differently and fail the
// comparison for a reason that is nobody's code. It failed exactly that way in CI on 2026-08-04.
const target = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
});

const app = express();

const proxyMiddleware = createProxyMiddleware({
    target: "http://127.0.0.1:13399/",
    changeOrigin: true,
    logger: console,
    on: {
        error: (err, req, res) => {
            console.error(err);
            res.json({
                error: err.message
            });
        }
    }
});

app.use("/api", proxyMiddleware);

target.listen(13399, () => {
    app.listen(13333, async () => {
        console.log("Server is running on port 13333");

        for (const path of ["/api", "/api/thing?q=1"]) {
            const body = await fetchTest(`http://localhost:13333${path}`).then((r) => r.text());
            console.log(path, body);
        }

        process.exit(0);
    });
});
