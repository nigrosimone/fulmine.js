// The Content-Disposition of res.attachment() and res.download() for the names content-disposition
// 2 treats differently: a token goes unquoted, a space or a quote keeps the quotes, a path keeps
// its base name, and no name is a bare attachment

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const names = ["user.html", "a b.txt", 'q"uote.txt', "dir/inside.txt", ".name", "", "semi;colon.txt", "tab\there.txt"];

const app = express();
app.set("etag", false);
names.forEach((name, i) => {
    app.get(`/attachment/${i}`, (req, res) => {
        res.attachment(name).send("x");
    });
    app.get(`/download/${i}`, (req, res) => {
        res.download("tests/parts/index.html", name || undefined);
    });
});
app.get("/attachment/none", (req, res) => {
    res.attachment().send("x");
});
app.get("/download/none", (req, res) => {
    res.download("tests/parts/index.html");
});

app.listen(13333, async () => {
    const paths = [
        ...names.map((n, i) => `/attachment/${i}`),
        "/attachment/none",
        ...names.map((n, i) => `/download/${i}`),
        "/download/none"
    ];
    await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, JSON.stringify(res.headers.get("content-disposition")));
            await res.text();
        })
    );
    process.exit(0);
});
