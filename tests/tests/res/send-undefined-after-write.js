// res.send() and res.send(undefined) after a res.write(): express writes no header for undefined,
// so it does not refuse a head that has gone out, and the pieces already written are the answer

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.get("/undefined", (req, res) => {
    res.write("chunk ");
    return res.send(undefined);
});
app.get("/bare", (req, res) => {
    res.write("chunk ");
    return res.send();
});
app.get("/end", (req, res) => {
    res.write("chunk ");
    return res.end();
});
// a body does set a header, so this one is refused on both, and neither can answer the error
app.get("/string", (req, res) => {
    res.write("chunk ");
    try {
        res.send("tail");
    } catch (err) {
        console.log("/string threw", err.code);
        res.end();
    }
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        ["/undefined", "/bare", "/end", "/string"].map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, res.status, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
