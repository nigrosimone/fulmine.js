// must support app.mountpath for mounted sub-applications

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const admin = express();
const api = express();
const multiMount = express();

app.use("/admin", admin);

app.use("/api", api);

app.use(["/multi1", "/multi2"], multiMount);

admin.get("/", (req, res) => {
    res.send("admin");
});

api.get("/", (req, res) => {
    res.send("api");
});

multiMount.get("/", (req, res) => {
    res.send("multi");
});

console.log("app.mountpath:", app.mountpath);
console.log("admin.mountpath:", admin.mountpath);
console.log("api.mountpath:", api.mountpath);
console.log("multiMount.mountpath:", JSON.stringify(multiMount.mountpath));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    // Verify routes work
    const adminRes = await fetchTest("http://localhost:13333/admin").then((res) => res.text());
    console.log("admin response:", adminRes);

    const apiRes = await fetchTest("http://localhost:13333/api").then((res) => res.text());
    console.log("api response:", apiRes);

    const multi1Res = await fetchTest("http://localhost:13333/multi1").then((res) => res.text());
    console.log("multi1 response:", multi1Res);

    const multi2Res = await fetchTest("http://localhost:13333/multi2").then((res) => res.text());
    console.log("multi2 response:", multi2Res);

    process.exit(0);
});
