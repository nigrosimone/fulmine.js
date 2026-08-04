// must run a router or an app by hand through handle()
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// what connect-style code does with something it was handed: call it with the request and a next,
// and expect the request back if nothing in there answered. Express has this on both an app and a
// router, and it is the form to give middleware that wants to run a whole app, since a mounted
// sub-app is a plain object here rather than a function.
const subApp = express();
subApp.get("/hello", (req, res) => res.send(`sub hello, req.app is the sub app: ${req.app === subApp}`));
subApp.get("/settings", (req, res) => res.send(`view engine: ${req.app.get("view engine")}`));
subApp.set("view engine", "pug");

const router = express.Router();
router.get("/routed", (req, res) => res.send("router routed"));

app.use("/sub", (req, res, next) => subApp.handle(req, res, next));
app.use("/router", (req, res, next) => router.handle(req, res, next));

// nothing in either answered, so next() ran and the request carried on down the chain
app.use((req, res) => res.status(404).send("fell through to the outer app"));

const ROUTES = ["/sub/hello", "/sub/settings", "/sub/nothing", "/router/routed", "/router/nothing"];

app.listen(13333, async () => {
    for (const route of ROUTES) {
        const response = await fetchTest("http://localhost:13333" + route);
        console.log(route, response.status, JSON.stringify(await response.text()));
    }

    process.exit(0);
});
