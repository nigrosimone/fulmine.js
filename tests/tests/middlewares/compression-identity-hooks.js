// Identity responses still run each compression filter, last installed first, after writeHead's
// headers have been applied. Repeated middleware must keep separate decisions and merge Vary.
const express = require("express");
const compression = express.compression || require("compression");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

for (const label of ["first", "second"]) {
    app.use(
        compression({
            filter(req, res) {
                const order = res.getHeader("x-filter-order");
                res.setHeader("x-filter-order", order ? `${order},${label}` : label);
                return res.getHeader("Content-Type") === "text/plain";
            }
        })
    );
}

app.get("/:mode/:kind", (req, res) => {
    const headers = {
        "Content-Type": req.params.kind === "skip" ? "image/png" : "text/plain",
        Vary: "Accept-Language"
    };
    if (req.params.kind === "no-transform") {
        headers["Cache-Control"] = "no-transform";
    }
    if (req.params.mode === "head") {
        res.writeHead(200, "Fine", headers);
    } else {
        for (const name in headers) {
            res.setHeader(name, headers[name]);
        }
    }
    res.end("identity");
});

app.listen(13333, async () => {
    for (const mode of ["end", "head"]) {
        for (const kind of ["vary", "skip", "no-transform"]) {
            const path = `/${mode}/${kind}`;
            const response = await fetchTest(`http://localhost:13333${path}`, {
                headers: { "Accept-Encoding": "identity" }
            });
            console.log(
                path,
                response.status,
                response.statusText,
                response.headers.get("x-filter-order"),
                await response.text()
            );
        }
    }
    process.exit(0);
});
