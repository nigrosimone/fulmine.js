// must shape what a verify hook throws the way http-errors shapes it for body-parser: an Error
// keeps its own status when it is one a client can be answered with, a thrown string becomes a
// 403 carrying it as the message, anything else a plain 403, and a status outside 4xx and 5xx
// with no message of its own becomes a 500

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const ok = (req, res) => res.json({ body: req.body });
const throwing = (make) =>
    express.json({
        verify: () => {
            throw make();
        }
    });

app.post(
    "/string",
    throwing(() => "nope"),
    ok
);
app.post(
    "/status-302",
    throwing(() => Object.assign(new Error("moved"), { status: 302 })),
    ok
);
app.post(
    "/status-600",
    throwing(() => Object.assign(new Error("too big"), { status: 600 })),
    ok
);
app.post(
    "/status-499",
    throwing(() => Object.assign(new Error("no message"), { status: 499 })),
    ok
);
app.post(
    "/statuscode",
    throwing(() => Object.assign(new Error("teapot"), { statusCode: 418 })),
    ok
);
app.post(
    "/object",
    throwing(() => ({ message: "plain", status: 401 })),
    ok
);
app.post(
    "/typed",
    throwing(() => Object.assign(new Error("typed"), { type: "my.own.type", status: 422 })),
    ok
);

app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({
        message: err.message ?? null,
        status: err.status ?? null,
        statusCode: err.statusCode ?? null,
        type: err.type ?? null,
        expose: err.expose ?? null,
        name: err.name ?? null,
        isError: err instanceof Error,
        hasBody: err.body !== undefined
    });
});

app.listen(13333, async () => {
    for (const path of ["/string", "/status-302", "/status-600", "/status-499", "/statuscode", "/object", "/typed"]) {
        const response = await fetchTest("http://localhost:13333" + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"a":1}'
        });
        console.log(path, response.status, await response.text());
    }
    process.exit(0);
});
