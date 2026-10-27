// express.urlencoded({ extended: false }) is qs at depth 0: an empty name and "__proto__" are dropped

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/test", (req, res) => {
    res.json({ keys: Object.keys(req.body), body: req.body });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const bodies = ["=v&a=1", "__proto__=x&a=1", "%5F_proto__=x&a=1", "=", "==&a=1", "a=1&=2&a=3", "a=%41%ZZ"];
    for (const body of bodies) {
        const res = await fetchTest("http://localhost:13333/test", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });
        console.log(body, res.status, await res.text());
    }

    process.exit(0);
});
