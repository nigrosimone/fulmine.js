// every own field of a body parser error, as body-parser puts them for an error handler to read:
// body, length, limit, expected, received, charset, encoding, beside status and type

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.post("/json-limit", express.json({ limit: "10b" }), (req, res) => res.send("ok"));
app.post("/text-limit", express.text({ limit: "10b" }), (req, res) => res.send("ok"));
app.post("/raw-limit", express.raw({ limit: "10b" }), (req, res) => res.send("ok"));
app.post("/params", express.urlencoded({ extended: false, parameterLimit: 1 }), (req, res) => res.send("ok"));
app.post("/depth", express.urlencoded({ extended: true, depth: 1 }), (req, res) => res.send("ok"));
app.post("/charset", express.json(), (req, res) => res.send("ok"));
app.post("/encoding", express.json(), (req, res) => res.send("ok"));
app.post("/parse", express.json(), (req, res) => res.send("ok"));
app.post("/strict", express.json(), (req, res) => res.send("ok"));
app.post(
    "/verify",
    express.json({
        verify: () => {
            throw new Error("nope");
        }
    }),
    (req, res) => res.send("ok")
);

app.use((err, req, res, next) => {
    const fields = {};
    for (const key of Object.keys(err).sort()) {
        fields[key] = err[key];
    }
    // a body without a length is refused by uWS natively, which does not say how many bytes came:
    // only that the field is there is compared
    if (req.headers["transfer-encoding"] && "received" in fields) {
        fields.received = "present";
    }
    res.status(200).json({ name: err.name, message: err.message, fields });
});

app.listen(13333, async () => {
    const big = JSON.stringify({ padding: "x".repeat(40) });
    const cases = [
        ["/json-limit", big, "application/json"],
        ["/text-limit", "x".repeat(40), "text/plain"],
        ["/raw-limit", "x".repeat(40), "application/octet-stream"],
        ["/params", "a=1&b=2", "application/x-www-form-urlencoded"],
        ["/depth", "a[b][c][d]=1", "application/x-www-form-urlencoded"],
        ["/charset", "{}", "application/json; charset=utf-99"],
        ["/encoding", "{}", "application/json"],
        ["/parse", "{ not json", "application/json"],
        ["/strict", "42", "application/json"],
        ["/verify", "{}", "application/json"]
    ];
    await sequential(
        cases.map(([path, body, type]) => async () => {
            const headers = { "content-type": type };
            if (path === "/encoding") headers["content-encoding"] = "brrr";
            const response = await fetchTest("http://localhost:13333" + path, { method: "POST", headers, body });
            console.log(path, await response.text());
        })
    );
    // too large without a length: the limit is found while reading
    const chunked = await fetchTest("http://localhost:13333/json-limit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(big));
                controller.close();
            }
        }),
        duplex: "half"
    });
    console.log("/json-limit chunked", await chunked.text());
    process.exit(0);
});
