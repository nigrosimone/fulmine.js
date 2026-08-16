// a router's param() runs for what its own pattern captured, not for what it inherited
//
// mergeParams puts the mounts' parameters into req.params, and reading that to decide which
// callbacks to run called this router's param() for names a mount above had captured. Express
// walks the keys the layer itself matched instead, so it never does. Visible whenever such a
// callback does anything: the ones here write a header, and one of them refused a value carrying a
// null byte, which turned a 200 into a 500.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// mergeParams, so :outer reaches this router's routes without being captured by them
const merging = express.Router({ mergeParams: true });
merging.param("outer", (req, res, next, value) => {
    res.append("X-Ran", "outer=" + value);
    next();
});
merging.param("own", (req, res, next, value) => {
    res.append("X-Ran", "own=" + value);
    next();
});
// a name the router never captures anywhere, which must never be called for
merging.param("absent", (req, res, next, value) => {
    res.append("X-Ran", "absent=" + value);
    next();
});
merging.get("/leaf/:own", (req, res) => res.json({ r: "leaf", params: req.params }));
// an optional group: when it does not match there is no value to call anything for
merging.get("/opt{/:own}", (req, res) => res.json({ r: "opt", params: req.params }));
app.use("/at/:outer", merging);

// and a plain router, where there is nothing inherited at all
const plain = express.Router();
plain.param("p", (req, res, next, value) => {
    res.append("X-Ran", "p=" + value);
    next();
});
plain.get("/:p", (req, res) => res.json({ r: "plain", params: req.params }));
app.use("/plain", plain);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/at/OUT/leaf/OWN", "/at/OUT/opt/OWN", "/at/OUT/opt", "/plain/P"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, JSON.stringify(res.headers.get("x-ran")), await res.text());
    }

    process.exit(0);
});
