// must frame a response the way its path frames it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// Two routes with the same body. The first compiles to a declarative response; the second cannot,
// because the handler calls something the compiler does not follow.
app.get("/compiled", (req, res) => res.send("ok"));
app.get("/ordinary", (req, res) => {
    const body = ["o", "k"].join("");
    res.send(body);
});

async function framingOf(path) {
    const response = await fetchTest("http://localhost:13333" + path);
    const body = await response.text();
    return {
        body,
        chunked: response.headers.get("transfer-encoding") === "chunked",
        length: response.headers.get("content-length")
    };
}

app.listen(13333, async () => {
    const compiled = await framingOf("/compiled");
    const ordinary = await framingOf("/ordinary");

    console.log("same body:", compiled.body === "ok" && ordinary.body === "ok");
    console.log("ordinary route carries a length:", ordinary.length === "2" && !ordinary.chunked);
    // a literal body is written in one piece, so uWS gives it a length like any other response
    console.log("compiled route carries a length:", compiled.length === "2" && !compiled.chunked);

    process.exit(0);
});
