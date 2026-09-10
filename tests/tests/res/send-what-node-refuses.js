// res.send() of a symbol, a bigint or a function: what node's Buffer throws for it is the answer,
// with and without an ETag to make, since express sizes the two differently

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const values = { symbol: Symbol("s"), bigint: 1n, fn: function named() {} };

function build(etag) {
    const app = express();
    app.set("etag", etag);
    for (const [name, value] of Object.entries(values)) {
        app.get("/" + name, (req, res) => res.send(value));
    }
    app.use((err, req, res, next) => res.status(500).type("txt").send(`${err.code}: ${err.message}`));
    return app;
}

build(true).listen(13333, () => {
    build(false).listen(13334, async () => {
        await sequential(
            [13333, 13334].flatMap((port) =>
                Object.keys(values).map((name) => async () => {
                    const res = await fetchTest(`http://localhost:${port}/${name}`);
                    console.log(port, name, await res.text());
                })
            )
        );
        process.exit(0);
    });
});
