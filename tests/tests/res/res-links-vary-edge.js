// several links under one rel, and a Vary asked for with nothing in it
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/links-array", (req, res) => {
    res.links({
        next: "http://api.example.com/users?page=2",
        // an array is several links that share a rel, one entry each
        last: ["http://api.example.com/users?page=5", "http://api.example.com/users?page=1"]
    });
    res.send(res.get("Link"));
});

app.get("/links-twice", (req, res) => {
    res.links({ next: "http://api.example.com/users?page=2" });
    res.links({ prev: "http://api.example.com/users?page=1" });
    res.send(res.get("Link"));
});

app.get("/vary-empty", (req, res) => {
    // an empty list is not the same as no argument: it sets nothing and does not throw
    res.vary([]);
    res.send(`vary: ${JSON.stringify(res.get("Vary"))}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/links-array", "/links-twice", "/vary-empty"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
