// must reject the removed req.param() and read from params, body and query instead

const express = require("express");

const app = express();

app.set("body methods", ["POST", "PUT", "PATCH", "DELETE"]);
app.use(express.json());

// req.param() was deprecated in Express 4 and removed in Express 5. The replacement is
// reading from the three places it used to search, in whichever one the value belongs.
app.get("/removed", (req, res) => {
    let threw = false;
    try {
        req.param("test");
    } catch (e) {
        threw = true;
    }
    res.send("threw: " + threw);
});

app.get("/params/:test", (req, res) => {
    res.send(String(req.params.test));
});

app.get("/query", (req, res) => {
    res.send(String(req.query.test));
});

app.delete("/body", (req, res) => {
    res.send(String(req.body.test));
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    console.log(await fetch("http://localhost:13333/removed").then((res) => res.text()));
    console.log(await fetch("http://localhost:13333/params/abc").then((res) => res.text()));
    console.log(await fetch("http://localhost:13333/query?test=qqq").then((res) => res.text()));
    console.log(
        await fetch("http://localhost:13333/body", {
            method: "DELETE",
            body: JSON.stringify({ test: "bbb" }),
            headers: { "Content-Type": "application/json" }
        }).then((res) => res.text())
    );

    process.exit(0);
});
