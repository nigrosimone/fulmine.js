// must support "jsonp callback name" setting for customizing JSONP callback parameter

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const app2 = express();

app2.set("jsonp callback name", "cb");

app.get("/jsonp", (req, res) => {
    res.jsonp({ message: "default" });
});

app2.get("/jsonp", (req, res) => {
    res.jsonp({ message: "custom" });
});

app.listen(13333, async () => {
    app2.listen(13334, async () => {
        // Test default callback name is 'callback'
        const defaultCallback = await fetchTest("http://localhost:13333/jsonp?callback=myFunc");
        console.log(await defaultCallback.text());
        console.log(defaultCallback.headers.get("content-type"));

        // Test default callback name - without callback param returns JSON
        const noCallback = await fetchTest("http://localhost:13333/jsonp");
        console.log(await noCallback.text());
        console.log(noCallback.headers.get("content-type"));

        // Test default callback name - wrong param name returns JSON
        const wrongParam = await fetchTest("http://localhost:13333/jsonp?cb=myFunc");
        console.log(await wrongParam.text());
        console.log(wrongParam.headers.get("content-type"));

        // Test custom callback name 'cb' works
        const customCallback = await fetchTest("http://localhost:13334/jsonp?cb=myCustomFunc");
        console.log(await customCallback.text());
        console.log(customCallback.headers.get("content-type"));

        // Test custom callback name - old 'callback' param no longer works
        const oldParam = await fetchTest("http://localhost:13334/jsonp?callback=myFunc");
        console.log(await oldParam.text());
        console.log(oldParam.headers.get("content-type"));

        // Test custom callback name - without callback param returns JSON
        const noCallbackCustom = await fetchTest("http://localhost:13334/jsonp");
        console.log(await noCallbackCustom.text());
        console.log(noCallbackCustom.headers.get("content-type"));

        process.exit(0);
    });
});
