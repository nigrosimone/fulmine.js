// router.stack, the layers express keeps, read back the way express keeps them
//
// Libraries that list an application's endpoints walk this, and so do tests that reach in for one
// handler by name: LibreChat's own tests pull a middleware out of their router that way, and while
// there was nothing there two of their suites could not even load. One layer per middleware, one
// per route with the route's handlers under it, and the names express reads off the handles:
// "handle" for a route, "router" and "app" for what is mounted.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const router = express.Router();
const one = function one(req, res, next) {
    next();
};
const two = function two(req, res, next) {
    next();
};

router.use(one, two);
router.get("/users/:id", one, function handler(req, res) {
    res.json({ id: req.params.id });
});
router.post("/users", function create(req, res) {
    res.status(201).end();
});
router.use("/sub", express.Router());
router.use("/app", express());

const shape = router.stack.map((layer) => ({
    name: layer.name,
    path: layer.path,
    keys: (layer.keys || []).map((key) => key.name),
    handle: typeof layer.handle,
    route: layer.route
        ? {
              path: layer.route.path,
              methods: layer.route.methods,
              stack: layer.route.stack.map((inner) => [inner.name, inner.method, typeof inner.handle])
          }
        : null
}));

console.log("layers:", router.stack.length);
console.log(JSON.stringify(shape, null, 1));
console.log("the layers keep their identity across reads:", router.stack[0] === router.stack[0]);
console.log("a route handler is reachable by name:", router.stack[2].route.stack[1].handle.name);

// and the router still serves what it was walked for
const app = express();
app.use(router);
app.listen(13355, async () => {
    console.log("Server is running on port 13355");
    await fetchTest("http://localhost:13355/users/7").then((res) => res.text().then((text) => console.log(text)));
    process.exit(0);
});
