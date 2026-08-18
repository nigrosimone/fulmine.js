// must route on the method a middleware rewrote, not on the one the request arrived with
//
// method-override is written to assign req.method, and express reads it again at every layer, so
// the route that answers is the one for the new verb. Here the chain in front of the route is
// native, and it was picked by the verb µWS dispatched on, so the rewrite has to send the request
// back through ordinary routing.

const express = require("express");
const methodOverride = require("method-override");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.use(methodOverride("X-HTTP-Method-Override"));

app.post("/thing", (req, res) => res.send("post route, method " + req.method));
app.delete("/thing", (req, res) => res.send("delete route, method " + req.method));
app.get("/only-get", (req, res) => res.send("get route, method " + req.method));
app.use((req, res) => res.status(404).send("no route, method " + req.method));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["/thing", "POST", "DELETE"],
        ["/thing", "POST", undefined],
        ["/thing", "POST", "PUT"],
        ["/only-get", "POST", "GET"],
        ["/only-get", "GET", undefined],
        // the verb it was already sent with, which changes nothing
        ["/thing", "POST", "POST"]
    ];

    for (const [path, method, override] of cases) {
        const res = await fetchTest(`http://localhost:13333${path}`, {
            method,
            headers: override ? { "X-HTTP-Method-Override": override } : {}
        });
        console.log(method, override ?? "-", path, res.status, await res.text());
    }

    process.exit(0);
});
