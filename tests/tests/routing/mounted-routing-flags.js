// a strict app must not make the routers mounted on it strict
//
// Express reads "strict routing" and "case sensitive routing" once, when it builds a router, and
// hands them over together: a Router keeps whatever its options said no matter what it is mounted
// on, and an application captures its own settings at that moment. So the mount order is visible
// from outside, and every shape below pins one case of it. The mirror case, a router stricter than
// the app it sits on, is in routers/mounted-router-options.js.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.set("strict routing", true);
app.set("case sensitive routing", true);

// a router with no options of its own: the app's strictness must not reach it
const loose = express.Router();
loose.get("/inner", (req, res) => res.send("loose"));
app.use("/loose", loose);

// a router that asked for both: it keeps them although the mount point could not care less
const tight = express.Router({ strict: true, caseSensitive: true });
tight.get("/inner", (req, res) => res.send("tight"));
app.use("/tight", tight);

// routers inside routers, none of them asking for anything
const outer = express.Router();
const nested = express.Router();
nested.get("/deep", (req, res) => res.send("deep"));
outer.use("/n", nested);
app.use("/outer", outer);

// a sub-application whose routes exist before it is mounted, which is the usual order: its
// router is already built, so the parent's settings arrive too late to change it
const early = express();
early.set("etag", false);
early.get("/inner", (req, res) => res.send("early"));
app.use("/early", early);

// the same sub-application mounted while still empty: the settings are in place before the
// router is built, so this one does come out strict and case sensitive
const late = express();
late.set("etag", false);
app.use("/late", late);
late.get("/inner", (req, res) => res.send("late"));

// a sub-application that says the opposite of its parent, which must win over what it inherits
const opinionated = express();
opinionated.set("etag", false);
opinionated.set("strict routing", false);
opinionated.set("case sensitive routing", false);
app.use("/opinionated", opinionated);
opinionated.get("/inner", (req, res) => res.send("opinionated"));

// the app's own routes, where the settings do apply
app.get("/own", (req, res) => res.send("own"));

// a mount path in the wrong case: the app is case sensitive, so this one is about the mount
// rather than the route below it
app.get("/loose/self", (req, res) => res.send("self"));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13458, async () => {
    console.log("Server is running on port 13458");

    const paths = [
        "/loose/inner",
        "/loose/inner/",
        "/loose/INNER",
        "/LOOSE/inner",
        "/tight/inner",
        "/tight/inner/",
        "/tight/INNER",
        "/outer/n/deep",
        "/outer/n/deep/",
        "/outer/N/DEEP",
        "/early/inner",
        "/early/inner/",
        "/early/INNER",
        "/late/inner",
        "/late/inner/",
        "/late/INNER",
        "/opinionated/inner",
        "/opinionated/inner/",
        "/opinionated/INNER",
        "/own",
        "/own/",
        "/OWN",
        "/loose/self",
        "/loose/self/"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13458${path}`);
        console.log(path, res.status, JSON.stringify(await res.text()));
    }

    process.exit(0);
});
