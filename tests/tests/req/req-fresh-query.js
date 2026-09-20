// req.fresh answers for a QUERY too since express 5.3: a matching validator is a 304, where
// before only GET and HEAD could be fresh

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);
const handler = (req, res) => {
    res.set("ETag", '"12345"');
    res.send(`${req.method} results`);
};
app.query("/reports", handler);
app.get("/reports", handler);
app.post("/reports", handler);
app.all("/all", handler);

app.listen(13333, async () => {
    await sequential(
        [
            ["QUERY", "/reports", '"12345"'],
            ["QUERY", "/reports", '"other"'],
            ["QUERY", "/reports", undefined],
            ["GET", "/reports", '"12345"'],
            ["POST", "/reports", '"12345"'],
            ["QUERY", "/all", '"12345"'],
            ["PUT", "/all", '"12345"']
        ].map(([method, path, tag]) => async () => {
            // fetch adds "cache-control: no-cache" beside a conditional header, which fresh() reads
            // as a refusal; a max-age of its own takes its place
            const res = await fetchTest(`http://localhost:13333${path}`, {
                method,
                headers: tag ? { "cache-control": "max-age=604800", "if-none-match": tag } : {},
                body: method === "GET" ? undefined : "q"
            });
            console.log(method, path, tag, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
