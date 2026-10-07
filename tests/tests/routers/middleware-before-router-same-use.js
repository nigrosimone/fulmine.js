// must run middlewares in the same use() call as a mounted router
// INSPECT
//
// ultimate-express skipped them once its router fast path was registered, GHSA-6cvg-gcw3-m8r8: a guard
// in front of a router served the router's routes unauthenticated. Each shape below is a guard that
// must answer 401, asked again after the time that fast path took to start.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const guard = (req, res, next) => {
    if (req.headers.authorization === "yes") return next();
    res.status(401).send("denied");
};
const pass = (req, res, next) => next();
const router = () => {
    const r = express.Router();
    r.get("/data", (req, res) => res.send("secret"));
    return r;
};
const subApp = express();
subApp.get("/data", (req, res) => res.send("secret"));

app.use("/private", guard, router());
app.use("/two", pass, guard, router());
app.use("/subapp", guard, subApp);
app.use("/array", [guard, router()]);
const outer = express.Router();
outer.use("/inner", guard, router());
app.use("/nested", outer);
app.use("/open", router());
// no path, so last: it takes every request the ones above leave
app.use(guard, router());

const paths = [
    "/private/data",
    "/two/data",
    "/subapp/data",
    "/array/data",
    "/nested/inner/data",
    "/open/data",
    "/data"
];

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

    process.exit(0);
});
