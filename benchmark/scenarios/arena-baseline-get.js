"use strict";

// HttpArena's baseline GET handler, with the same query access and connection-header setting
// as the published adapter. Compare with arena-baseline-post to include its text body parser.
function sumQuery(query) {
    let sum = 0;
    for (const k in query) {
        const n = parseInt(query[k], 10);
        if (n === n) sum += n;
    }
    return sum;
}

module.exports = {
    name: "routing/arena-baseline-get",
    path: "/baseline11?a=13&b=42",
    setup(app) {
        app.set("connection headers", false);
        app.get("/baseline11", (req, res) => {
            res.type("text/plain").send(String(sumQuery(req.query)));
        });
    }
};
