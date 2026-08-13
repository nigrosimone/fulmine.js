// express.serverTiming(), this project's own: the browser's own tools say how the request was
// routed and how long the server took, per request.
//
//   node server-timing.js
//   curl -sD - -o /dev/null http://localhost:3000/api/items/7
//   Server-Timing: route;desc="native", hdr;desc="copied", db;dur=27.34, cache;desc="miss", total;dur=29.46
//
// route;desc="native" means uWS matched the path in C++ and the chain was worked out at startup;
// route;desc="router" means this one was matched here, layer by layer. A route compiled into a
// response never enters JavaScript, so nothing times it: npx fulmine.js profile counts those.
const express = require("fulmine.js"); // instead of require("express")

const app = express();

app.use(
    express.serverTiming({
        routing: true, // how the request was routed. Default true
        total: true, // the time up to the head. Default true
        name: "total" // what the total is called
    })
);

app.get("/api/items/:id", async (req, res) => {
    // res.time() times a piece of work under a name and gives back whatever it returned. A
    // promise is timed to where it settles
    const item = await res.time("db", () => query(req.params.id));

    // res.timing() adds a mark by hand. The duration is optional: a mark with only a description
    // is a legal entry, and is how a cache hit is usually reported
    res.timing("cache", undefined, "miss");

    res.json(item);
});

/**
 * Stands in for the database this route would have.
 *
 * @param {string} id
 */
function query(id) {
    return new Promise((resolve) => setTimeout(() => resolve({ id, name: `item ${id}` }), 20));
}

// The duration ends where the header does, since Server-Timing goes out with the head: anything
// measured after that cannot be in it.
app.listen(3000, () => console.log("http://localhost:3000/api/items/7"));
