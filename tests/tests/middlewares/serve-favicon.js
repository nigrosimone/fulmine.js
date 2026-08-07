// must support serve-favicon
// INSPECT
//
// It answers one path and hands every other request on, and what it answers is a cached buffer with
// its own ETag and Cache-Control. So it checks a middleware that sends a body of its own, the
// conditional request that follows it, and the method rules it enforces.

const express = require("express");
const path = require("path");
const favicon = require("serve-favicon");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.use(favicon(path.join(__dirname, "..", "..", "parts", "favicon.ico"), { maxAge: 60000 }));

app.get("/", (req, res) => res.send("not the icon"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const icon = await fetchTest("http://localhost:13333/favicon.ico");
    const etag = icon.headers.get("etag");
    console.log("/favicon.ico", icon.status, icon.headers.get("content-type"), icon.headers.get("cache-control"));
    console.log("  bytes:", (await icon.arrayBuffer()).byteLength, "etag present:", typeof etag === "string");

    // the conditional request the browser sends next, answered from the same cached buffer
    const conditional = await fetchTest("http://localhost:13333/favicon.ico", {
        headers: { "if-none-match": etag }
    });
    console.log("  revalidated:", conditional.status, JSON.stringify(await conditional.text()));

    // a HEAD, which sends the headers and no body
    const head = await fetchTest("http://localhost:13333/favicon.ico", { method: "HEAD" });
    console.log("  head:", head.status, head.headers.get("content-length"));

    // anything but GET and HEAD is refused by the middleware itself, with Allow
    const posted = await fetchTest("http://localhost:13333/favicon.ico", { method: "POST" });
    console.log("  posted:", posted.status, posted.headers.get("allow"));

    // and every other path walks past it
    const other = await fetchTest("http://localhost:13333/");
    console.log("/", other.status, await other.text());

    process.exit(0);
});
