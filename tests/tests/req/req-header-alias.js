// req.header is req.get by another name, on the prototype and not an own property of the request

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.send(
        `value=${req.header("x-probe")}` +
            ` own=${Object.prototype.hasOwnProperty.call(req, "header")}` +
            ` same=${req.header === req.get}`
    );
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const res = await fetchTest("http://localhost:13333/test", { headers: { "x-probe": "yes" } });
    console.log(await res.text());

    process.exit(0);
});
