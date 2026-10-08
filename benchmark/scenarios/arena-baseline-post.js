"use strict";

// HttpArena's baseline POST handler: sum the query and a small text body using the published
// adapter's parser and connection-header setting. The type callback also accepts requests that
// omit Content-Type, as HttpArena's load generator does.
function sumQuery(query) {
    let sum = 0;
    for (const k in query) {
        const n = parseInt(query[k], 10);
        if (n === n) sum += n;
    }
    return sum;
}

const querystring = require("querystring");

module.exports = {
    name: "routing/arena-baseline-post",
    path: "/baseline11?a=13&b=42",
    request: {
        method: "POST",
        body: "20"
    },
    setup(app, express) {
        app.set("connection headers", false);
        const readText = express.text({ type: () => true });
        app.post("/baseline11", readText, (req, res) => {
            let total = sumQuery(req.query);
            const n = parseInt(typeof req.body === "string" ? req.body.trim() : "", 10);
            if (n === n) total += n;
            res.type("text/plain").send(String(total));
        });
    },
    // node:http by hand, what --shim measures the shim against
    nodeHttp(req, res) {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            let total = sumQuery(querystring.parse(req.url.slice(req.url.indexOf("?") + 1)));
            const n = parseInt(body.trim(), 10);
            if (n === n) total += n;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(String(total));
        });
    }
};
