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
        "/nothing/a%zz"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
