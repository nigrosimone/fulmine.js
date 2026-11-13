// a real Express app mounted with app.use
//
// Libraries ship their own express() app for the user to mount (@bull-board/express, Parse Server's
// api.app). Express's handle() moves req and res onto its own prototypes, and Fulmine treated the
// app as plain middleware, so nothing moved them back: the process died after the first request.
// Found by integrations/cases/bullboard.js.

const express = require("express");
const realExpress = require("express");
const path = require("path");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("custom", "outer");

const inner = realExpress();
inner.set("json spaces", 2);
inner.set("views", __dirname);
inner.engine("js", (file, options, callback) => callback(null, `rendered ${path.basename(file)} for ${options.who}`));
inner.use(realExpress.json());

inner.get("/json", (req, res) => res.json({ a: 1, custom: req.app.get("custom") }));
inner.get("/render", (req, res) => res.render("mounted-express-app.js", { who: "inner" }));
inner.get("/where", (req, res) =>
    res.json({
        appIsInner: req.app === inner,
        resAppIsInner: res.app === inner,
        mountpath: inner.mountpath,
        parentIsApp: inner.parent === app,
        baseUrl: req.baseUrl,
        originalUrl: req.originalUrl,
        url: req.url,
        protocol: req.protocol,
        hostname: req.hostname,
        query: req.query
    })
);
inner.post("/body", (req, res) => res.set("x-inner", "yes").json(req.body));
inner.get("/fail", (req, res, next) => next(new Error("inner failed")));

app.use("/inner", inner);

// past the mounted app the request is the outer app's again
app.use((req, res, next) => {
    res.set("x-outer-app", String(req.app === app && res.app === app));
    next();
});
app.get("/inner/missing", (req, res) => res.send(`outer took it, custom ${req.app.get("custom")}`));
app.get("/after", (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => res.status(500).send(`${err.message}, app is outer: ${req.app === app}`));

app.listen(13334, async () => {
    console.log("Server is running on port 13334");

    const outputs = await sequential(
        [
            ["/inner/json"],
            ["/inner/render"],
            ["/inner/where?x=1"],
            ["/inner/body", { method: "POST", headers: { "content-type": "application/json" }, body: '{"b":2}' }],
            ["/inner/missing"],
            ["/inner/fail"],
            ["/after"],
            ["/inner/json"]
        ].map(([url, init]) => async () => {
            const res = await fetchTest(`http://localhost:13334${url}`, init);
            return `${url} ${res.status} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
