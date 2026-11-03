// req.params in a pathless middleware: one object for the layer, a new one in the next layer
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const seen = [];

app.use((req, res, next) => {
    req.params.mark = "first";
    seen.push(`same ${req.params === req.params} ${req.params.mark}`);
    next();
});
// reads nothing: the next layer still gets its own
app.use((req, res, next) => next());
app.use((req, res, next) => {
    seen.push(`next ${req.params.mark} ${Object.keys(req.params).length}`);
    next();
});

const inner = express.Router({ mergeParams: true });
inner.use((req, res, next) => {
    seen.push(`merged ${req.params.id} ${Object.getPrototypeOf(req.params) === null}`);
    next();
});
inner.get("/", (req, res) => {
    res.send(`${seen.join(", ")}, route ${req.params.id}`);
});
app.use("/items/:id", inner);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/items/7", "/items/8/"]) {
        seen.length = 0;
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
