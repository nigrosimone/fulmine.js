// must support named splats in routes

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test/*splat", (req, res) => {
    res.send("test");
});

app.get("/*splat", (req, res) => {
    res.send("*");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res = await fetchTest("http://localhost:13333/test/999");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/test/sdfs/1999");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/999");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/sdfs/1999");
    console.log(await res.text());

    process.exit(0);
});
