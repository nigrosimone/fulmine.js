// must bound the extended parse the way body-parser bounds it: a depth overflow is a 400 with
// body-parser's wording, the depth option is honoured and validated, and the array ceiling rises
// to the parameter count so a long form array stays an array

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.post("/ext", express.urlencoded({ extended: true }), (req, res) =>
    res.json({ isArray: Array.isArray(req.body.a), len: Object.keys(req.body.a ?? {}).length })
);
app.post("/deep", express.urlencoded({ extended: true }), (req, res) => res.json({ ok: true }));
app.post("/deep50", express.urlencoded({ extended: true, depth: 50 }), (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({
        err: err.message,
        type: err.type ?? null,
        status: err.status ?? null
    });
});

// an invalid depth is refused where it is written, not where a request arrives
for (const depth of [-1, "x"]) {
    try {
        express.urlencoded({ extended: true, depth });
        console.log("depth", depth, "no throw");
    } catch (err) {
        console.log("depth", depth, `${err.constructor.name}: ${err.message}`);
    }
}

const deep40 = "a" + "[b]".repeat(40) + "=1";
const arr150 = Array.from({ length: 150 }, (_, i) => `a[${i}]=${i}`).join("&");

const post = (route, body) =>
    fetchTest("http://localhost:13333" + route, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
    });

app.listen(13333, async () => {
    const cases = [
        ["/deep", deep40],
        ["/deep50", deep40],
        ["/ext", arr150],
        // under the ceiling nothing changes
        ["/ext", "a[0]=x&a[1]=y"]
    ];

    for (const [route, body] of cases) {
        const response = await post(route, body);
        console.log(route, response.status, await response.text());
    }

    process.exit(0);
});
