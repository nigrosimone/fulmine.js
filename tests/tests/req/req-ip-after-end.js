// must support req.ip after response
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.write("ok");
    res.end(() => {
        console.log(req.ip);
    });
    console.log(req.ip);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res;
    res = await fetchTest("http://localhost:13333/test");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/test");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/test");
    console.log(await res.text());

    process.exit(0);
});
