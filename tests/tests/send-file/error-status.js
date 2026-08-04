// must hand the callback an error with a status on it
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const path = require("path");

const app = express();
const parts = path.join(process.cwd(), "tests/parts");
const dotfile = path.join(parts, ".test.txt");

// send builds its errors with http-errors, so each carries status, statusCode and expose. Code
// reading err.status in the callback, or an error handler doing res.status(err.status || 500),
// finds a 403 or a 412 rather than nothing, which is the difference between the client being told
// what it did and being told the server broke.
function report(res, err) {
    res.status(200).send(
        err
            ? `status=${err.status} statusCode=${err.statusCode} expose=${err.expose} code=${err.code} message=${err.message}`
            : "no error"
    );
}

app.get("/dotfile-deny", (req, res) => res.sendFile(dotfile, { dotfiles: "deny" }, (e) => report(res, e)));
app.get("/dotfile-ignore", (req, res) => res.sendFile(dotfile, { dotfiles: "ignore" }, (e) => report(res, e)));
app.get("/climbs-out", (req, res) => res.sendFile("../../package.json", { root: parts }, (e) => report(res, e)));
app.get("/missing", (req, res) => res.sendFile(path.join(parts, "nope.txt"), (e) => report(res, e)));

// a directory is not an error send reports at all: it emits "directory", and res.sendFile has no
// listener for one, so what reaches the callback is an EISDIR with no status
app.get("/directory", (req, res) => res.sendFile(parts, (e) => report(res, e)));

// and the two that are the calling code being wrong rather than the request, which throw where
// they are called instead of reaching the callback
app.get("/no-path", (req, res) => {
    try {
        res.sendFile();
    } catch (e) {
        res.send(`threw ${e.constructor.name}: ${e.message}`);
    }
});

app.get("/not-a-string", (req, res) => {
    try {
        res.sendFile(42);
    } catch (e) {
        res.send(`threw ${e.constructor.name}: ${e.message}`);
    }
});

app.get("/relative-no-root", (req, res) => {
    try {
        res.sendFile("tests/parts/small-file.json");
    } catch (e) {
        res.send(`threw ${e.constructor.name}: ${e.message}`);
    }
});

const ROUTES = [
    "/dotfile-deny",
    "/dotfile-ignore",
    "/climbs-out",
    "/missing",
    "/directory",
    "/no-path",
    "/not-a-string",
    "/relative-no-root"
];

app.listen(13333, async () => {
    for (const route of ROUTES) {
        const response = await fetchTest("http://localhost:13333" + route);
        const body = await response.text();
        // the fs errors name the file they could not read, and the path leading to it is this
        // machine's rather than anything about the behaviour
        console.log(route, response.status, JSON.stringify(body.replaceAll(process.cwd(), "<cwd>")));
    }

    process.exit(0);
});
