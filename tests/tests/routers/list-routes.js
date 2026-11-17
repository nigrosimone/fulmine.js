// router.listRoutes() of router 2.3: a path per entry, a route's verbs, a mounted router to recurse
// into, and nothing for middleware or a mounted app

const express = require("express");

const app = express();
const ok = (req, res) => res.send("ok");

app.use(function logger(req, res, next) {
    next();
});
app.get("/users/:id", ok);
app.post("/users", ok);
app.all("/everything", ok);
app.get(["/a", "/b/"], ok);
app.get(/^\/re\/(\d+)$/, ok);
app.route("/chained").get(ok).post(ok).put(ok);
app.route("/head").head(ok).get(ok);

const api = express.Router();
api.get("/items", ok);
api.delete("/items/:id", ok);
api.all("/any", ok);
const nested = express.Router();
nested.patch("/deep", ok);
api.use("/nested", nested);
app.use("/api", api);
app.use(express.Router());
app.use(["/x", "/y"], express.Router());

const sub = express();
sub.get("/hello", ok);
app.use("/sub", sub);

const show = (router, depth) => {
    for (const entry of router.listRoutes()) {
        const path = entry.path instanceof RegExp ? String(entry.path) : JSON.stringify(entry.path);
        console.log(`${"  ".repeat(depth)}${path} ${JSON.stringify(entry.methods)} ${entry.router ? "router" : "-"}`);
        if (entry.router) {
            show(entry.router, depth + 1);
        }
    }
};
show(app.router, 0);
console.log(typeof express.Router().listRoutes, JSON.stringify(express.Router().listRoutes()));
