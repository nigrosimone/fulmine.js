// must support libraries that copy their own methods onto an app, as @feathersjs/express does

const express = require("express");
const { fetchTest } = require("../../helpers.js");

// @feathersjs/express 5: what is not on the app or its direct prototype is taken for missing
function mixin(target, source) {
    const have = {
        ...Object.getOwnPropertyDescriptors(Object.getPrototypeOf(target)),
        ...Object.getOwnPropertyDescriptors(target)
    };
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
        if (!have[name]) {
            Object.defineProperty(target, name, descriptor);
        }
    }
}

const foreign = {
    get: () => "foreign get",
    set: () => "foreign set",
    use: () => "foreign use",
    listen: () => "foreign listen",
    route: () => "foreign route",
    on: () => "foreign on",
    service: () => "own service"
};

const app = express();
mixin(app, foreign);

console.log(
    "app keeps",
    ["get", "set", "use", "listen", "route", "on"].filter((name) => app[name] !== foreign[name])
);
console.log("app gains", app.service());

app.set("etag", false);
const router = express.Router();
router.get("/item", (req, res) => res.send("item"));
app.use("/r", router);
app.get("/health", (req, res) => res.send("ok"));

app.listen(13333, async () => {
    for (const path of ["/health", "/r/item"]) {
        const response = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, response.status, await response.text(), response.headers.get("etag"));
    }
    process.exit(0);
});
