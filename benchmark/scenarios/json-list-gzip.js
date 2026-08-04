"use strict";

// json-list, compressed per request, which is HttpArena's json-comp profile. Kept apart from
// json-list because the two answer different questions: this one is capped by zlib and the other
// is not, and reading them together is how a compression change gets mistaken for a routing one.
//
// Level 1 on purpose: the leaderboards measure throughput of compressed JSON, and the payloads are
// small enough that a higher level buys bytes nobody counts.
const zlib = require("zlib");

const ITEM_COUNT = 50;
const GZIP_OPTIONS = { level: 1 };

const dataset = Array.from({ length: ITEM_COUNT }, (item, index) => ({
    id: index,
    name: `item-${index}`,
    category: index % 7 === 0 ? "tools" : "parts",
    price: 10 + (index % 90),
    quantity: 1 + (index % 5),
    active: index % 3 !== 0,
    tags: ["alpha", "beta", index % 2 === 0 ? "even" : "odd"],
    rating: { score: 1 + (index % 5), count: 10 * index }
}));

module.exports = {
    name: "routing/json-list-gzip",
    path: `/json/${ITEM_COUNT}?m=3`,
    request: {
        method: "GET",
        headers: { "Accept-Encoding": "gzip" }
    },
    bound: {
        by: "zlib deflate of the serialized list, which both servers hand to the same library",
        ceiling: "~1.3x"
    },
    setup(app) {
        app.get("/json/:count", (req, res) => {
            let count = parseInt(req.params.count, 10) || 0;
            if (count > dataset.length) count = dataset.length;
            const m = parseInt(req.query.m, 10) || 1;
            const items = [];
            for (let i = 0; i < count; i++) {
                const d = dataset[i];
                items.push({
                    id: d.id,
                    name: d.name,
                    category: d.category,
                    price: d.price,
                    quantity: d.quantity,
                    active: d.active,
                    tags: d.tags,
                    rating: d.rating,
                    total: d.price * d.quantity * m
                });
            }
            const body = JSON.stringify({ items, count });
            if ((req.headers["accept-encoding"] || "").includes("gzip")) {
                res.set("Content-Encoding", "gzip").type("application/json").send(zlib.gzipSync(body, GZIP_OPTIONS));
            } else {
                res.type("application/json").send(body);
            }
        });
    }
};
