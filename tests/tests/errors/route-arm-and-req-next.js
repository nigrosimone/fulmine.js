// which error handler hears a failure raised by res.render and res.sendFile
//
// A four argument handler written inside a route only catches what the route handed it through its
// own next(). These two report to req.next instead, which the router owns, so the rest of the route
// is skipped and the error surfaces past it. The fuzzer found res.render doing the opposite: the
// route's own arm answered 418 where express had already left the route and answered 500.
// INSPECT

const express = require("express");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("views", "tests/parts");
app.set("view engine", "html");
app.engine("html", (filePath, options, callback) => callback(null, "rendered"));

const caught = (err, req, res, next) => res.status(418).send("the route caught: " + err.message.split("\n")[0]);

// each route carries its own four argument handler, which is what must not run
app.get(
    "/render-missing",
    (req, res) => res.render("nowhere"),

    caught
);
app.get(
    "/render-callback",
    (req, res) => res.render("nowhere", (err) => res.status(200).send("the callback heard: " + Boolean(err))),
    caught
);
// res.format belongs on this list and is not on it: express hands its handlers the router next as
// well, but express's own suite asserts the handler is given the very same function the surrounding
// middleware received, and outside a route the two nexts here are equivalent without being
// identical. See the open question at Walk's constructor in router.js
app.get("/sendfile-missing", (req, res) => res.sendFile(path.resolve("tests/parts/not-there.txt")), caught);
// and one that raises through the route's own next(), which the arm must catch
app.get("/route-next", (req, res, next) => next(new Error("from the route")), caught);

app.use((req, res) => res.status(404).send("no route"));
app.use((err, req, res, next) => res.status(err.status || 500).send("the app caught: " + err.message.split("\n")[0]));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["/render-missing", {}],
        ["/render-callback", {}],
        ["/sendfile-missing", {}],
        ["/route-next", {}]
    ];

    for (const [url, headers] of cases) {
        const res = await fetchTest(`http://localhost:13333${url}`, { headers });
        const body = (await res.text()).replace(/[A-Za-z]:[\\/][^\s"]*?tests/g, "<root>/tests");
        console.log(url, res.status, body);
    }

    process.exit(0);
});
