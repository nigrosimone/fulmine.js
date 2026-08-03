// must read the socket's own encrypted flag when trust proxy has no X-Forwarded-Proto

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.enable("trust proxy");

app.get("/test", (req, res) => {
    req.socket.encrypted = true;
    res.end(req.protocol + " " + req.secure);
});

app.get("/plain", (req, res) => {
    // untouched socket keeps the listener's own scheme
    res.end(req.protocol + " " + req.secure);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res;
    res = await fetchTest("http://localhost:13333/test");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/plain");
    console.log(await res.text());

    // a trusted forwarded proto still wins over the socket flag
    res = await fetchTest("http://localhost:13333/test", { headers: { "X-Forwarded-Proto": "http" } });
    console.log(await res.text());

    process.exit(0);
});
