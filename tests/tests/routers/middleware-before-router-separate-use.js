// must run middlewares of an earlier app.use() for the routes of a router mounted after
//
// ultimate-express 2.2.0 skipped them for router.get() routes, GHSA-xj56-gg5c-459v: a guard in its own
// app.use() let every route of the next router through, and express.json() left req.body undefined.
// No INSPECT here: its middleware in front of the app would hide the shape under test.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const guard = (req, res, next) => {
    if (req.headers.authorization === "yes") return next();
    res.status(401).send("denied");
};
const router = () => {
    const r = express.Router();
    r.get("/data", (req, res) => res.send("secret"));
    return r;
};

const app = express();
app.use(express.json());
const body = express.Router();
body.post("/body", (req, res) => res.send(req.body ? "body " + JSON.stringify(req.body) : "no body"));
app.use(body);
app.use(guard);
app.use(router());
app.use("/api", router());
const items = express.Router();
items.get("/", (req, res) => res.send("list"));
items.get("/:id", (req, res) => res.send("item " + req.params.id));
app.use("/items", items);
const outer = express.Router();
outer.use("/inner", router());
app.use("/nested", outer);
const subApp = express();
subApp.get("/data", (req, res) => res.send("secret"));
app.use("/subapp", subApp);
app.route("/chain").get((req, res) => res.send("secret"));

const paths = ["/data", "/api/data", "/items/", "/items/7", "/nested/inner/data", "/subapp/data", "/chain"];

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const path of paths) {
        let res = await fetchTest("http://localhost:13333" + path);
        console.log(path, res.status, await res.text());

        res = await fetchTest("http://localhost:13333" + path, {
            headers: { authorization: "yes" }
        });
        console.log(path, res.status, await res.text());
    }

    const res = await fetchTest("http://localhost:13333/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 })
    });
    console.log("/body", res.status, await res.text());

    process.exit(0);
});
