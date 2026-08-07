// must support express-basic-auth
// INSPECT
//
// A middleware that answers instead of continuing, with a status, a header the client acts on and a
// body it writes itself. It also reads the Authorization header and hangs what it found on the
// request, so both directions of the request object are covered.

const express = require("express");
const basicAuth = require("express-basic-auth");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

/** @param {string} user @param {string} password */
const credentials = (user, password) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

app.use("/plain", basicAuth({ users: { admin: "secret" } }));
app.get("/plain", (req, res) => res.send("in"));

// with the challenge, which is what makes a browser ask, and a realm
app.use("/challenge", basicAuth({ users: { admin: "secret" }, challenge: true, realm: "the test" }));
app.get("/challenge", (req, res) => res.send("in"));

// an authoriser of its own, and the name it found left on the request
app.use(
    "/custom",
    basicAuth({
        authorizer: (user, password) => user.startsWith("guest") && password === "open",
        unauthorizedResponse: (req) => ({ denied: req.auth ? req.auth.user : "nobody" })
    })
);
app.get("/custom", (req, res) => res.json({ user: req.auth.user }));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["/plain", undefined],
        ["/plain", credentials("admin", "secret")],
        ["/plain", credentials("admin", "wrong")],
        ["/challenge", undefined],
        ["/custom", credentials("guest-1", "open")],
        ["/custom", credentials("someone", "open")]
    ];

    for (const [path, authorization] of cases) {
        const res = await fetchTest(`http://localhost:13333${path}`, {
            headers: authorization ? { authorization } : undefined
        });
        console.log(
            path,
            authorization ? "with credentials" : "anonymous",
            res.status,
            JSON.stringify(res.headers.get("www-authenticate")),
            await res.text()
        );
    }

    process.exit(0);
});
