// a writeHead that throws over a header name has already fixed the reason phrase, and node keeps
// it: the 500 answered after it goes out as "500 OK", or with the phrase writeHead was given

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.get("/default-phrase", (req, res) => {
    try {
        res.writeHead(200, { "bad name": "x" });
    } catch {
        res.status(500).end("refused");
    }
});
app.get("/own-phrase", (req, res) => {
    try {
        res.writeHead(200, "Fine", { "bad name": "x" });
    } catch {
        res.status(500).end("refused");
    }
});
app.get("/no-throw", (req, res) => {
    res.writeHead(201, { "X-Ok": "x" });
    res.end("made");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        ["/default-phrase", "/own-phrase", "/no-throw"].map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, res.status, JSON.stringify(res.statusText), await res.text());
        })
    );
    process.exit(0);
});
