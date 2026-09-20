// res.send() under a Transfer-Encoding the application set itself: express 5.3 adds no
// Content-Length next to it, so the body goes out chunked as the header says. Both set at once is
// left out, express then writes both and a client refuses the response. end() and write() under
// the header, which express 5.2 already framed, are res/end-with-transfer-encoding.js

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.get("/chunked", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.send("hello");
});
app.get("/chunked-buffer", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.send(Buffer.from("hello"));
});
app.get("/chunked-json", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.json({ a: 1 });
});
app.get("/chunked-empty", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.send("");
});
app.get("/chunked-status", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.status(201).send("made");
});
app.get("/plain", (req, res) => {
    res.send("hello");
});

app.listen(13333, async () => {
    const paths = ["/chunked", "/chunked-buffer", "/chunked-json", "/chunked-empty", "/chunked-status", "/plain"];
    await sequential(
        paths.flatMap((path) => [
            async () => {
                const res = await fetchTest(`http://localhost:13333${path}`);
                console.log("GET", path, JSON.stringify(await res.text()));
            },
            async () => {
                const res = await fetchTest(`http://localhost:13333${path}`, { method: "HEAD" });
                console.log("HEAD", path, JSON.stringify(await res.text()));
            }
        ])
    );
    process.exit(0);
});
