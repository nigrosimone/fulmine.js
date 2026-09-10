// send() and json() of undefined still strip a 204 and a 304: the type json set goes with them

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.get("/json-204", (req, res) => res.status(204).json(undefined));
app.get("/json-304", (req, res) => res.status(304).json(undefined));
app.get("/send-204", (req, res) => res.status(204).send(undefined));
app.get("/bare-204", (req, res) => res.status(204).send());
app.get("/json-200", (req, res) => res.json(undefined));
// a validator set by hand, which the freshness check compares against even with nothing to send
app.get("/fresh", (req, res) => res.set("ETag", '"fixed"').json(undefined));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        ["/json-204", "/json-304", "/send-204", "/bare-204", "/json-200"].map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, res.status, JSON.stringify(await res.text()));
        })
    );
    const fresh = await fetchTest("http://localhost:13333/fresh", { headers: { "if-none-match": '"fixed"' } });
    console.log("/fresh", fresh.status, JSON.stringify(await fresh.text()));
    process.exit(0);
});
