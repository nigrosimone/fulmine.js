// must support res.jsonp()
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("jsonp callback name", "callback2");

app.get("/test", (req, res) => {
    res.jsonp({ test: "test" });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/test?callback2=test");
    console.log(await response.text(), response.headers.get("content-type"));

    const response2 = await fetchTest("http://localhost:13333/test");
    console.log(await response2.text(), response2.headers.get("content-type"));

    const response3 = await fetchTest("http://localhost:13333/test?asdf=test");
    console.log(await response3.text(), response3.headers.get("content-type"));

    process.exit(0);
});
