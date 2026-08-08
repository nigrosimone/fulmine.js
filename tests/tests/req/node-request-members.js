// must have the request members node has, and abort the signal when the client goes away
// INSPECT

// express's Request extends node's IncomingMessage, and the types this package re-exports promise
// everything on it. req.signal is the one that does real work: @angular/ssr reads it when it builds
// a web Request, which is how an SSR render learns the visitor has gone.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/members", (req, res) => {
    res.json({
        signal: typeof req.signal,
        aborted: req.signal.aborted,
        sameEveryTime: req.signal === req.signal,
        trailers: req.trailers,
        trailersDistinct: req.trailersDistinct,
        setTimeout: typeof req.setTimeout
    });
});

let sawAbort = false;
app.get("/leaving", (req, res) => {
    req.signal.addEventListener("abort", () => {
        sawAbort = true;
    });
    // never answered: the client gives up first
    setTimeout(() => res.end("too late"), 3000);
});

app.get("/did-it-abort", (req, res) => {
    res.json({ sawAbort });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const members = await fetchTest("http://localhost:13333/members");
    console.log("members", await members.text());

    const controller = new AbortController();
    const gone = fetchTest("http://localhost:13333/leaving", { signal: controller.signal }).catch(() => "client left");
    setTimeout(() => controller.abort(), 150);
    console.log("client", await gone);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const asked = await fetchTest("http://localhost:13333/did-it-abort");
    console.log("server noticed", await asked.text());

    process.exit(0);
});
