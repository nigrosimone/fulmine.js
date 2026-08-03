// a mounted sub-app answers with its own settings, not with the parent's

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("json spaces", 0);

// Express hands both the request and the response to the app that is handling them, by re-parenting
// them onto that app's own prototypes. So these two settings decide what comes out of this router,
// even though the request arrived at the parent
const sub = express();
sub.set("json spaces", 4);
sub.set("etag fn", () => undefined);
sub.get("/json", (req, res) => res.json({ a: 1 }));
sub.get("/who", (req, res) => res.send(`${req.app.get("json spaces")} ${res.app.get("json spaces")}`));
app.use("/sub", sub);

app.get("/json", (req, res) => res.json({ a: 1 }));
app.get("/who", (req, res) => res.send(`${req.app.get("json spaces")} ${res.app.get("json spaces")}`));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/json", "/sub/json", "/who", "/sub/who"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, JSON.stringify(res.headers.get("etag")), JSON.stringify(await res.text()));
    }

    process.exit(0);
});
