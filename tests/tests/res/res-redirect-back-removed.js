// res.redirect('back') treats 'back' as literal URL instead of Referrer
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.redirect("back");
});

app.get("/test2", (req, res) => {
    res.location("back");
    res.send("ok");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const r1 = await fetchTest("http://localhost:13333/test", { redirect: "manual" });
    console.log("status: " + r1.status);
    console.log("location: " + r1.headers.get("location"));

    const r2 = await fetchTest("http://localhost:13333/test2");
    console.log("location2: " + r2.headers.get("location"));

    process.exit(0);
});
