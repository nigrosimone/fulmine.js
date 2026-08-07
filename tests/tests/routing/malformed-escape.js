// a percent escape that will not decode is a 400, and it is decided by the path alone
//
// Express matches a layer's path and decodes its parameters before it looks at the method, so a
// request whose verb no route answers still gets the 400 rather than a 404. A literal path is
// matched as bytes and decodes nothing, so an escape written into one is not an error at all.
// The error is a URIError, which is what an error handler testing the class sees.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/lit/bad%zz", (req, res) => res.send("a literal path with an escape in it"));
app.get("/p/:id", (req, res) => res.json({ where: "param", id: req.params.id }));
app.put("/put/:id", (req, res) => res.json({ where: "put", id: req.params.id }));
app.get("/w/*rest", (req, res) => res.json({ where: "wildcard", rest: req.params.rest }));

const mounted = express.Router();
mounted.get("/inner", (req, res) => res.json({ where: "mounted", base: req.baseUrl }));
app.use("/m/:mid", mounted);

// a middleware that refuses the path before any of that, with a parameter route behind it that
// would also fail to decode. Matching a route decodes its parameters even while the walk is only
// looking for an error handler, and express keeps the error it already has rather than replacing
// it, so what comes out is this refusal and not the decode failure of a route that never runs
app.use("/first", (req, res, next) => {
    const refusal = new Error("the middleware refused it");
    refusal.status = 400;
    next(refusal);
});
app.get("/first/:id", (req, res) => res.json({ where: "never reached", id: req.params.id }));

app.use((req, res) => res.status(404).send("no route"));
app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
        message: err.message,
        status: err.status ?? null,
        isUriError: err instanceof URIError
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        // a parameter that will not decode, in every spelling of broken
        "/p/a%zz",
        "/p/a%",
        "/p/%C3%28",
        "/p/%",
        "/p/ok",
        // the path matches a route whose method does not, and express decodes anyway
        "/put/a%zz",
        "/put/ok",
        // one segment of a wildcard, which is decoded segment by segment
        "/w/a%zz/b",
        "/w/ok/b",
        // the mount path carries the parameter
        "/m/a%zz/inner",
        "/m/ok/inner",
        // a literal path matches as bytes, so nothing is decoded and nothing fails
        "/lit/bad%zz",
        // and no route at all is still a plain 404
        "/nothing/a%zz",
        // the first error wins: the middleware refused before the route behind it was matched, and
        // matching it would have failed to decode
        "/first/a%zz",
        "/first/ok"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
