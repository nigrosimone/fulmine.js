// mergeParams reaches the router that asked for it, and stops at one that did not
// INSPECT
//
// Express asks each router in turn whether it wants the parameters of the mounts above it. A plain
// router mounted inside a mergeParams one does not, and its routes see only what their own pattern
// captured. Reading a stack that a mergeParams router had filled meant those parameters leaked one
// level further down than express takes them.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const echo = (where) => (req, res) => res.json({ where, params: req.params });

// a mergeParams router mounted under a parameter, with a plain router inside it
const merging = express.Router({ mergeParams: true });
merging.get("/own/:inner", echo("merging own"));
const plain = express.Router();
plain.get("/leaf/:leaf", echo("plain leaf"));
merging.use("/plain", plain);
app.use("/outer/:outer", merging);

// and the other way round: a mergeParams router inside a plain one still reads what is above it
const outerPlain = express.Router();
const innerMerging = express.Router({ mergeParams: true });
innerMerging.get("/leaf/:leaf", echo("merging leaf"));
outerPlain.use("/inner", innerMerging);
app.use("/plainouter/:po", outerPlain);

// two deep, both merging, which is where the order of the stack shows
const first = express.Router({ mergeParams: true });
const second = express.Router({ mergeParams: true });
second.get("/leaf/:leaf", echo("both merging"));
first.use("/second/:mid", second);
app.use("/both/:top", first);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = ["/outer/A/own/B", "/outer/A/plain/leaf/C", "/plainouter/D/inner/leaf/E", "/both/F/second/G/leaf/H"];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
