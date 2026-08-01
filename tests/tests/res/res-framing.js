// must frame a response the way its path frames it

const express = require("express");

const app = express();

// Two routes with the same body. The first compiles to a declarative response; the second cannot,
// because the handler calls something the compiler does not follow.
app.get("/compiled", (req, res) => res.send("ok"));
app.get("/ordinary", (req, res) => {
    const body = ["o", "k"].join("");
    res.send(body);
});

// The framing differs between them on Fulmine and not on Express, so this asks which server it is
// running on rather than comparing the two directly. uWS writes a declarative response chunked and
// sets Transfer-Encoding itself; a Content-Length cannot be added alongside it, since a response
// carrying both is invalid and clients reject it.
const isFulmine = !!app.uwsApp;

async function framingOf(path) {
    const response = await fetch("http://localhost:13333" + path);
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
    console.log(
        "compiled route framed as this server frames it:",
        isFulmine ? compiled.chunked && compiled.length === null : compiled.length === "2" && !compiled.chunked
    );

    process.exit(0);
});
