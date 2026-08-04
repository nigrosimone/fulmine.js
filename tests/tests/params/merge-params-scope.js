// a mergeParams router's params are scoped to it: the sibling route after the mount must not
// INSPECT
// inherit what the child pushed

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const child = express.Router({ mergeParams: true });
child.get("/inside", (req, res, next) => next());

app.use("/m/:a", child);
app.get("/m/:b/inside", (req, res) => res.json(req.params));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const res = await fetchTest("http://localhost:13333/m/AAA/inside");
    console.log(res.status, await res.text());

    process.exit(0);
});
