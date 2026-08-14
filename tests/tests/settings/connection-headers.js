// must stop advertising the connection when asked to, and still say close

const express = require("express");

const app = express();

// "connection headers" is this project's own, so Express ignores it and keeps sending both. What
// is compared is this file's own answers, which both servers must print alike, so the requests
// here are plain fetches: fetchTest would print the very headers the setting removes.
const isFulmine = !!app.uwsApp;
app.set("connection headers", false);

app.get("/compiled", (req, res) => res.send("ok"));
app.get("/ordinary", (req, res) => {
    const body = ["o", "k"].join("");
    res.send(body);
});

app.listen(13333, async () => {
    for (const path of ["/compiled", "/ordinary"]) {
        const response = await fetch("http://localhost:13333" + path);
        await response.text();
        const advertised = response.headers.get("connection") === "keep-alive" || response.headers.has("keep-alive");
        console.log(`${path} advertises the connection:`, advertised === !isFulmine);
    }

    // a connection that is closing still says so: what the setting drops is the advertisement,
    // not the truth. Only the ordinary path can know, a compiled response being written once
    const closing = await fetch("http://localhost:13333/ordinary", { headers: { connection: "close" } });
    await closing.text();
    console.log("a closing connection still says close:", closing.headers.get("connection") === "close");

    process.exit(0);
});
