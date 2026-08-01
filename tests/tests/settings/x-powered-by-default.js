// must leave x-powered-by off by default, unlike Express

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/", (req, res) => res.send("ok"));

// The default differs from Express on purpose, so the two servers cannot be compared directly
// here. The file asks which one it is running on and asserts that server's own default, which
// makes both print the same line and keeps the comparison meaningful.
const isFulmine = !!app.uwsApp;

app.listen(13333, async () => {
    const response = await fetchTest("http://localhost:13333/");
    await response.text();

    const header = response.headers.get("x-powered-by");
    const expected = isFulmine ? null : "Express";
    console.log("x-powered-by is this server's default:", header === expected);

    // and it comes back when asked for
    const on = express();
    on.set("x-powered-by", true);
    on.get("/", (req, res) => res.send("ok"));
    on.listen(13334, async () => {
        const second = await fetchTest("http://localhost:13334/");
        await second.text();
        console.log("switched on:", second.headers.get("x-powered-by") !== null);
        process.exit(0);
    });
});
