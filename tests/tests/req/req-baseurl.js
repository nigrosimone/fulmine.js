// must support req.baseUrl
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const greet = express.Router();

greet.get("/jp", function (req, res) {
    res.send(req.baseUrl);
});

app.use(["/greeet", "/helo"], greet);

app.use("/greet", (req, res, next) => {
    res.send(req.baseUrl);
});

app.use((req, res, next) => {
    res.send("404");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res = await fetchTest("http://localhost:13333/greet/jp");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/hello/jp");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/greet/fsg");
    console.log(await res.text());

    // res = await fetchTest('http://localhost:13333/greet/test');
    // console.log(await res.text());

    process.exit(0);
});
