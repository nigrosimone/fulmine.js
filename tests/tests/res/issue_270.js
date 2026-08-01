// issue 270

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/", async (req, res) => {
    try {
        const messages = { asd: 2 };
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(13333, async () => {
    console.log(`Server listening on port ${13333}`);
    console.log(await fetchTest("http://localhost:13333/").then((r) => r.text()));
    process.exit(0);
});
