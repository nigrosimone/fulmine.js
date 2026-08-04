"use strict";

// The shape the public leaderboards measure as "json": build a list of objects per request and
// serialize it. HttpArena's json profile and its json-comp profile are both this, one plain and one
// gzipped, and fulmine sits mid-table among the JavaScript entries on the compressed one, which is
// what this scenario is here to move.
//
// The list is built per request on purpose, from a dataset held once, because that is what those
// benchmarks ask for and what an API endpoint does: a cached string would measure nothing but the
// socket. 50 items with a computed total is HttpArena's own shape.
const ITEM_COUNT = 50;

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
    name: "routing/json-list",
    path: `/json/${ITEM_COUNT}?m=3`,
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
            res.json({ items, count });
        });
    }
};
