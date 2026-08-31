// the socket methods an application calls on a request it holds open
//
// setTimeout, setKeepAlive and setNoDelay are node's, and an application that keeps a request open
// calls them, almost always to take the timeout off before it starts streaming. There is no per
// socket timeout to set under µWS, so what matters here is only that they are callable and hand the
// socket back the way node's do. n8n's chat trigger calls setTimeout on every webhook it serves,
// and a missing method there came back as a 500 with the cause swallowed.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/tune", (req, res) => {
    const back = req.socket.setTimeout(0);
    console.log("setTimeout returned the socket:", back === req.socket);
    console.log("setKeepAlive returned the socket:", req.socket.setKeepAlive(true, 1000) === req.socket);
    console.log("setNoDelay returned the socket:", req.socket.setNoDelay(true) === req.socket);
    console.log("through connection too:", req.connection.setTimeout(0) === req.connection);
    res.send("tuned");
});

app.use((err, req, res, next) => res.status(500).send("error: " + err.message));

app.listen(13352, async () => {
    console.log("Server is running on port 13352");
    await fetchTest("http://localhost:13352/tune").then((res) => res.text().then((text) => console.log(text)));
    process.exit(0);
});
