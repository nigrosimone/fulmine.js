// must give the body parser errors the name and the identity http-errors gives them

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// body-parser builds its errors through http-errors, so each status comes with a class of its own:
// an application logging err.name reads "PayloadTooLargeError", and a bad body is a SyntaxError
// that `err instanceof SyntaxError` finds. All of them were a bare Error here until 2026-08-19.
app.post("/limit", express.json({ limit: "10b" }), (req, res) => res.send("ok"));
app.post("/params", express.urlencoded({ extended: false, parameterLimit: 1 }), (req, res) => res.send("ok"));
app.post("/charset", express.json(), (req, res) => res.send("ok"));
app.post("/encoding", express.json(), (req, res) => res.send("ok"));
app.post("/parse", express.json(), (req, res) => res.send("ok"));
app.post("/strict", express.json(), (req, res) => res.send("ok"));

// what a verify hook throws is handed on rather than copied, so the class it chose and the
// properties it put on the error are still there
app.post(
    "/verify-type",
    express.json({
        verify: () => {
            throw new TypeError("bad shape");
        }
    }),
    (req, res) => res.send("ok")
);
app.post(
    "/verify-props",
    express.json({
        verify: () => {
            const err = new Error("nope");
            err.detail = "mine";
            throw err;
        }
    }),
    (req, res) => res.send("ok")
);

app.use((err, req, res, next) => {
    res.status(200).json({
        name: err.name,
        syntax: err instanceof SyntaxError,
        status: err.status ?? null,
        type: err.type ?? null,
        detail: err.detail ?? null
    });
});

app.listen(13333, async () => {
    const cases = [
        ["/limit", JSON.stringify({ padding: "x".repeat(200) }), "application/json"],
        ["/params", "a=1&b=2", "application/x-www-form-urlencoded"],
        ["/charset", "{}", "application/json; charset=utf-99"],
        ["/encoding", "{}", "application/json"],
        ["/parse", "{ not json", "application/json"],
        ["/strict", "42", "application/json"],
        ["/verify-type", "{}", "application/json"],
        ["/verify-props", "{}", "application/json"]
    ];

    for (const [path, body, type] of cases) {
        const headers = { "content-type": type };
        if (path === "/encoding") headers["content-encoding"] = "brrr";
        const response = await fetchTest("http://localhost:13333" + path, { method: "POST", headers, body });
        console.log(path, await response.text());
    }
    process.exit(0);
});
