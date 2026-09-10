// the final handler's status: the error's own when it is an error status, and with it the headers
// the error carries; else the response's when that is one; else 500. Content headers go.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("env", "production");

// a status set before failing that is not an error status is not kept
app.get("/created-then-next", (req, res, next) => {
    res.statusCode = 201;
    next(new Error("after a 201"));
});
// one that is an error status is
app.get("/not-found-then-throw", (req, res) => {
    res.status(404);
    throw new Error("after a 404");
});
// the error's own status wins over whatever the handler set, and its headers come along
app.get("/status-on-the-error", (req, res) => {
    res.status(201);
    const err = new Error("carrying 503");
    err.status = 503;
    err.headers = { "Retry-After": "5", "X-Error": "carried" };
    throw err;
});
// headers on an error without an error status are not written
app.get("/headers-without-status", () => {
    const err = new Error("no status");
    err.headers = { "X-Error": "dropped" };
    throw err;
});
// a status outside the error range on the error is ignored, and statusCode is read after status
app.get("/redirect-status-on-the-error", () => {
    const err = new Error("a 302 on the error");
    err.status = 302;
    err.statusCode = 422;
    throw err;
});
// a content header set before failing is removed from the page
app.get("/content-headers", (req, res) => {
    res.set("Content-Encoding", "identity");
    res.set("Content-Language", "en");
    res.set("Content-Range", "bytes 0-1/2");
    throw new Error("with content headers");
});

const paths = [
    "/created-then-next",
    "/not-found-then-throw",
    "/status-on-the-error",
    "/headers-without-status",
    "/redirect-status-on-the-error",
    "/content-headers"
];

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(
                path,
                res.status,
                res.headers.get("retry-after"),
                res.headers.get("x-error"),
                res.headers.get("content-language"),
                await res.text()
            );
        })
    );
    process.exit(0);
});
