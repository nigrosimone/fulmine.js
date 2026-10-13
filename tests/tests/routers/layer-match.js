// layer.match(path) on app.router.stack, as Colyseus asks it whether something answers "/"

const express = require("express");

const app = express();
const router = express.Router();
router.get("/x", (req, res) => res.send("x"));

app.use(express.json());
app.use("/api", function api(req, res, next) {
    next();
});
app.get("/hello", (req, res) => res.send("hello"));
app.get("/users/:id", (req, res) => res.send(req.params.id));
app.post("/", (req, res) => res.send("root"));
app.use("/r", router);

const PATHS = ["/", "/hello", "/hello/", "/HELLO", "/users/7", "/api", "/api/x", "/apix", "/r/x"];
for (const layer of app.router.stack) {
    console.log(layer.name, PATHS.map((path) => `${path}=${layer.match(path)}`).join(" "));
}
for (const layer of router.stack) {
    console.log("router", layer.name, layer.match("/x"), layer.match("/y"));
}
