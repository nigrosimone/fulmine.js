// an application mounted on a plain router keeps its own layer after it hands back
//
// Express restores req.app by putting the request prototype back, and it wraps a mounted
// application to do that only in Application#use. Hang one off a plain Router and nothing restores
// it, so whatever runs afterwards still reads the settings and the extensions of the application
// that was entered. It shows on the etag setting, which res.send reads from req.app.
// Found by fuzzing route tables against express.
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.set("name", "outer");

// mounted on a plain router, which is where express does not restore
const carrier = express.Router();
const onRouter = express();
onRouter.set("name", "on-router");
onRouter.get("/inside", (req, res) => res.send("router-mounted app"));
carrier.use("/app", onRouter);
app.use("/viarouter", carrier);

// mounted on the application, which is where it does
const onApp = express();
onApp.set("name", "on-app");
onApp.get("/inside", (req, res) => res.send("app-mounted app"));
app.use("/viaapp", onApp);

app.use((req, res) => res.status(404).json({ app: req.app.get("name") }));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        // the sub-app answers: both ways it is the one running
        "/viarouter/app/inside",
        "/viaapp/inside",
        // the sub-app hands back and something after it answers: this is where the two differ
        "/viarouter/app/missing",
        "/viaapp/missing",
        "/elsewhere"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
