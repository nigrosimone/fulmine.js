// must support req.xhr

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    console.log(req.xhr);
    res.send("test");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    await fetchTest("http://localhost:13333/test").then((res) => res.text());
    await fetchTest("http://localhost:13333/test", {
        headers: {
            "X-Requested-With": "XMLHttpRequest"
        }
    }).then((res) => res.text());

    await fetchTest("http://localhost:13333/test", {
        headers: {
            "X-Requested-With": "xmlhttprequest"
        }
    }).then((res) => res.text());

    process.exit(0);
});
