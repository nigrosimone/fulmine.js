// server.close() must let the request being served finish before closing

const express = require("express");
const http = require("http");

const app = express();

app.get("/slow", (req, res) => setTimeout(() => res.send("done"), 300));

const server = app.listen(13333, () => {
    let closeFired = false;

    // agent: false sends Connection: close, so no idle keep-alive socket outlives the
    // response and both servers can report 'close' promptly
    const client = new Promise((resolve) => {
        http.get({ port: 13333, path: "/slow", agent: false }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve(`${res.statusCode} ${body}`));
        }).on("error", (err) => resolve(`error ${err.code}`));
    });

    // close while the request is still being served: the client must still get the response
    setTimeout(() => {
        server.close(() => {
            closeFired = true;
        });
    }, 50);

    client.then(async (result) => {
        console.log("client got:", result);
        await new Promise((r) => setTimeout(r, 500));
        console.log("close fired:", closeFired);
        process.exit(0);
    });
});
