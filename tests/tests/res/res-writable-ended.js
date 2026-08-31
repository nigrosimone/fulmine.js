// what the response says about itself before and after it has been answered
//
// node sets writableEnded when end() is called and writableFinished once the bytes are out. Here
// end() hands the whole response over, so the two land together, but both have to be true after it:
// an application asks whether it has already answered before it writes again, or before it lets go
// of what it was streaming. LibreChat's agent stream reads writableEnded to decide whether to keep
// a subscription alive, and while it answered false forever the subscription was never dropped.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// writableFinished is deliberately not in here. node sets it when the bytes are actually gone, so
// right after end() it is true or false depending on whether the write flushed synchronously: true
// on Windows, false on the CI runners. This project hands the whole response to µWS in end() and
// answers true from there, which is the same approximation it has always made, and comparing it
// here would only be comparing the machine.
const state = (res) => ({
    writableEnded: res.writableEnded,
    finished: res.finished,
    headersSent: res.headersSent
});

app.get("/send", (req, res) => {
    console.log("before send:", JSON.stringify(state(res)));
    res.send("body");
    console.log("after send: ", JSON.stringify(state(res)));
});

app.get("/end", (req, res) => {
    console.log("before end:", JSON.stringify(state(res)));
    res.end("body");
    console.log("after end: ", JSON.stringify(state(res)));
});

app.get("/write-then-end", (req, res) => {
    res.write("one");
    console.log("after write:", JSON.stringify(state(res)));
    res.end("two");
    console.log("after end:  ", JSON.stringify(state(res)));
});

app.listen(13354, async () => {
    console.log("Server is running on port 13354");
    for (const path of ["/send", "/end", "/write-then-end"]) {
        await fetchTest(`http://localhost:13354${path}`).then((res) =>
            res.text().then((text) => console.log(path, "->", text))
        );
    }
    process.exit(0);
});
