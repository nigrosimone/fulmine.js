// must support helmet middleware
// INSPECT
//
// The default set, then the parts an application actually configures: a policy of its own, one
// piece turned off, and single middlewares used on their own. Every header is printed rather than a
// chosen few, so a header helmet adds or drops shows up here rather than silently.

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const helmet = require("helmet");

const app = express();
app.set("etag", false);

/** Everything helmet is responsible for, in a stable order. */
function security(res) {
    const out = {};
    for (const [name, value] of [...res.headers.entries()].sort()) {
        if (name === "date" || name === "connection" || name === "keep-alive" || name === "content-length") continue;
        out[name] = value;
    }
    return out;
}

const defaults = express();
defaults.set("etag", false);
defaults.use(helmet());
defaults.get("/", (req, res) => res.send("1"));
app.use("/defaults", defaults);

// a content security policy of the application's own, which is the piece most projects change
const policy = express();
policy.set("etag", false);
policy.use(
    helmet({
        contentSecurityPolicy: {
            directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", "data:"], scriptSrc: ["'self'"] }
        },
        // an application behind a proxy that terminates TLS turns this one off
        strictTransportSecurity: false,
        referrerPolicy: { policy: "no-referrer-when-downgrade" }
    })
);
policy.get("/", (req, res) => res.send("2"));
app.use("/policy", policy);

// and the pieces on their own, which is how helmet is used when only one is wanted
const pieces = express();
pieces.set("etag", false);
pieces.use(helmet.noSniff());
pieces.use(helmet.frameguard({ action: "deny" }));
pieces.use(helmet.hidePoweredBy());
pieces.get("/", (req, res) => {
    res.setHeader("x-powered-by", "something");
    res.send("3");
});
app.use("/pieces", pieces);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/defaults/", "/policy/", "/pieces/"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
        for (const [name, value] of Object.entries(security(res))) {
            console.log("   ", name + ":", value);
        }
    }

    process.exit(0);
});
