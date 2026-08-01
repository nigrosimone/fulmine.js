// must return the same thing Express returns from every chainable method

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const lines = [];

function check(label, actual, expected) {
    lines.push(label + ": " + (actual === expected));
}

check("app.set", app.set("foo", 1), app);
check("app.enable", app.enable("bar"), app);
check("app.disable", app.disable("bar"), app);
check(
    "app.engine",
    app.engine("zz", () => {}),
    app
);
check(
    "app.param",
    app.param("id", (req, res, next) => next()),
    app
);
check(
    "app.use",
    app.use((req, res, next) => next()),
    app
);

const router = express.Router();
check(
    "router.use",
    router.use((req, res, next) => next()),
    router
);
check(
    "router.param",
    router.param("id", (req, res, next) => next()),
    router
);

app.get("/x", (req, res) => {
    check("res.status", res.status(200), res);
    check("res.set", res.set("x-a", "1"), res);
    check("res.append", res.append("x-b", "1"), res);
    check("res.type", res.type("json"), res);
    check("res.attachment", res.attachment("f.txt"), res);
    check("res.cookie", res.cookie("c", "1"), res);
    check("res.clearCookie", res.clearCookie("c"), res);
    check("res.location", res.location("/y"), res);
    check("res.links", res.links({ next: "/n" }), res);
    check("res.vary", res.vary("Accept"), res);
    // node's OutgoingMessage returns nothing here, and Express does not override it
    check("res.removeHeader returns undefined", res.removeHeader("x-b"), undefined);
    check("res.json", res.json({ a: 1 }), res);

    console.log(lines.join("\n"));
    process.exit(0);
});

app.listen(13333, () => fetchTest("http://localhost:13333/x"));
