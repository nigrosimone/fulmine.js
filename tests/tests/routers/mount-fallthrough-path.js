// a request that falls out of a mounted router is offered to the app as its whole path again

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// the shape that reaches the native router: one parameter route, nothing after it that could match
const users = express.Router();
users.get("/:id", (req, res, next) => {
    console.log("router saw", req.params.id, req.url, req.baseUrl);
    next();
});
app.use("/users", users);

// an app route named like the tail of the mounted path. It must not answer /users/list: the request
// left the router as /users/list, not as /list
app.get("/list", (req, res) => res.send("app /list"));

app.use((req, res) => res.status(404).send(`nothing matched ${req.url} of ${req.originalUrl}`));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/users/list", "/list"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
