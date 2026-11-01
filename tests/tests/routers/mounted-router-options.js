// a mounted router's own strict and caseSensitive settings decide, not the app's
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// strict, mounted on an app that is not: /things/ is not the same path as /things here, and the
// route is registered natively, which is the only place that could have got it wrong
const strict = express.Router({ strict: true });
strict.get("/things", (req, res) => res.send("strict things"));
strict.get("/items/:id", (req, res) => res.send(`strict item ${req.params.id}`));
app.use("/s", strict);

// and case insensitive, mounted on an app that is not
const insensitive = express.Router({ caseSensitive: false });
insensitive.get("/users", (req, res) => res.send("insensitive users"));
app.use("/api", insensitive);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/s/things", "/s/things/", "/s/items/7", "/s/items/7/", "/api/users", "/api/USERS"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
