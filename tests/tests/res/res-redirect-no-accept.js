// a redirect to a client accepting neither text nor html carries no Content-Type and no body

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.redirect("/somewhere");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/test", {
        redirect: "manual",
        headers: { Accept: "application/json" }
    });
    console.log([await response.text()]);

    // the text branch, as a control
    const text = await fetchTest("http://localhost:13333/test", {
        redirect: "manual",
        headers: { Accept: "text/plain" }
    });
    console.log([await text.text()]);

    process.exit(0);
});
