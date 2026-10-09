// The peer as a logger or a tracer reads it from its "finish" listener, after the response is out:
// node's socket still answers then, so a socket reached for during the request does too

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

/** @type {string} what the finish listener read, printed by the client in a fixed order */
let peer = "not read";

const app = express();
app.set("etag", false);
app.get("/peer", (req, res) => {
    // reached for during the request, as on-finished and the tracers do
    const socket = req.socket;
    res.on("finish", () => {
        setImmediate(() => {
            peer = [
                "after finish",
                typeof socket.remotePort,
                socket.remotePort > 0,
                socket.remoteFamily,
                typeof socket.remoteAddress
            ].join(" ");
        });
    });
    res.send("ok");
});

app.listen(13333, async () => {
    await sequential([
        async () => {
            const res = await fetchTest("http://localhost:13333/peer");
            console.log(await res.text());
            await new Promise((resolve) => setTimeout(resolve, 50));
            console.log(peer);
        }
    ]);
    process.exit(0);
});
