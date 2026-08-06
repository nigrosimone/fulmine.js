// test that enabled() and disabled() read a mounted sub-app's inherited settings, as get() does
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const inheriting = express();
const own = express();

app.set("a truthy setting", "parent value");
app.set("a falsy setting", false);
own.set("a truthy setting", false);
own.set("a falsy setting", "child value");

app.use("/inheriting", inheriting);
app.use("/own", own);

// the sub-app that set nothing answers what the parent holds, and the one that set its own
// answers itself: express chains the settings objects at mount, so both are one lookup
console.log("inheriting truthy:", inheriting.enabled("a truthy setting"), inheriting.disabled("a truthy setting"));
console.log("inheriting falsy:", inheriting.enabled("a falsy setting"), inheriting.disabled("a falsy setting"));
console.log("own truthy:", own.enabled("a truthy setting"), own.disabled("a truthy setting"));
console.log("own falsy:", own.enabled("a falsy setting"), own.disabled("a falsy setting"));
console.log("never set:", inheriting.enabled("nobody set this"), inheriting.disabled("nobody set this"));

inheriting.get("/says", (req, res) => res.send(String(req.app.enabled("a truthy setting"))));
own.get("/says", (req, res) => res.send(String(req.app.enabled("a truthy setting"))));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/inheriting/says", "/own/says"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
