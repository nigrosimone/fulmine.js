// an error raised under OPTIONS reaches the error handlers, not the default page
//
// A router that collected verbs for the automatic reply stopped the walk when it handed back, so an
// error carried out of it was never offered to the handlers written after the mount and the default
// error page answered instead. The automatic reply is what stops in the router; an error is not,
// and express carries it on for OPTIONS as for any other method.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// all(), so it answers an OPTIONS itself and can fail while doing it
const failing = express.Router();
failing.all("/boom", (req, res, next) => next(new Error("passed by the route")));
app.use("/mounted", failing);

// and a router with no OPTIONS route of its own, so the automatic reply is what would answer
const collecting = express.Router();
collecting.put("/thing", (req, res) => res.send("put"));
collecting.post("/thing", (req, res) => res.send("post"));
app.use("/collect", collecting);

// a middleware that fails before the mount, for the case where the error is already there
const early = express.Router();
early.put("/early", (req, res) => res.send("put"));
app.use("/early", (req, res, next) => next(new Error("passed before the mount")), early);

app.use((req, res) => res.status(404).send("no route"));
app.use((err, req, res, next) => res.status(500).send("handler saw: " + err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [method, path] of [
        ["OPTIONS", "/mounted/boom"],
        ["GET", "/mounted/boom"],
        // nothing failed here, so the automatic reply still answers
        ["OPTIONS", "/collect/thing"],
        ["OPTIONS", "/early/early"],
        ["GET", "/early/early"]
    ]) {
        const res = await fetchTest(`http://localhost:13333${path}`, { method });
        console.log(method, path, res.status, res.headers.get("allow"), await res.text());
    }

    process.exit(0);
});
