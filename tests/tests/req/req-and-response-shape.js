// must agree on the request values and the response headers, not just the body

const express = require("express");
const { fetchTest, inspectRequest } = require("../../helpers.js");

const app = express();

app.use(inspectRequest);

app.get("/plain", (req, res) => res.send("hello"));
app.get("/json", (req, res) => res.json({ a: 1, b: [2, 3] }));
app.get("/typed", (req, res) => res.type("txt").send("typed"));
app.get("/redirect", (req, res) => res.redirect("/plain"));
app.get("/cookie", (req, res) => res.cookie("a", "1").cookie("b", "2").send("cookies"));
app.get("/varied", (req, res) => res.vary("Accept-Language").set("Cache-Control", "no-store").send("varied"));
app.get("/params/:id/:rest", (req, res) => res.send(JSON.stringify(req.params)));
app.post("/echo", express.json(), (req, res) => res.json(req.body));

app.listen(13333, async () => {
    await fetchTest("http://localhost:13333/plain").then((res) => res.text());
    await fetchTest("http://localhost:13333/json").then((res) => res.text());
    await fetchTest("http://localhost:13333/typed").then((res) => res.text());
    await fetchTest("http://localhost:13333/redirect", { redirect: "manual" }).then((res) => res.text());
    await fetchTest("http://localhost:13333/cookie").then((res) => res.text());
    await fetchTest("http://localhost:13333/varied").then((res) => res.text());
    await fetchTest("http://localhost:13333/params/7/a/b").then((res) => res.text());
    await fetchTest("http://localhost:13333/plain?x=1&y[]=2&y[]=3").then((res) => res.text());
    await fetchTest("http://localhost:13333/plain", { headers: { "X-Requested-With": "XMLHttpRequest" } }).then((res) =>
        res.text()
    );
    await fetchTest("http://localhost:13333/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" })
    }).then((res) => res.text());
    await fetchTest("http://localhost:13333/missing").then((res) => res.text());

    process.exit(0);
});
