// download's Content-Disposition: from the alternate filename, never overridable through the
// headers option, and absent entirely when the transfer fails before it starts

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/alternate", (req, res) => {
    // Content-Type must come from the path's extension, not from the alternate name
    res.download("package.json", "document");
});

app.get("/override", (req, res) => {
    res.download("package.json", "doc.txt", {
        headers: { "content-disposition": "inline", "X-Extra": "yes" }
    });
});

app.get("/fails", (req, res) => {
    res.download("does-not-exist.txt", (err) => {
        res.end(err ? "failed" : "no error");
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const alternate = await fetchTest("http://localhost:13333/alternate");
    await alternate.text();

    const override = await fetchTest("http://localhost:13333/override");
    console.log([override.headers.get("x-extra")]);
    await override.text();

    const fails = await fetchTest("http://localhost:13333/fails");
    console.log(await fails.text());

    process.exit(0);
});
