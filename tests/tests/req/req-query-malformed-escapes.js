// a broken escape in the query keeps the escapes around it decoded, as node's querystring does

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/q", (req, res) => res.json(req.query));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const query of ["a=%41%ZZ", "%41%ZZ=1", "a=%E2%82%AC%", "a+b=%41+%"]) {
        const res = await fetchTest("http://localhost:13333/q?" + query);
        console.log(query, res.status, await res.text());
    }

    process.exit(0);
});
