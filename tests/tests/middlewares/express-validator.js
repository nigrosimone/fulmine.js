// must support express-validator
// INSPECT
//
// It reads the body, the query and the route parameters through its own accessors and hangs its
// result on the request, so it exercises all three request surfaces at once and the sanitisers
// write back to them.

const express = require("express");
const { body, query, param, validationResult, matchedData } = require("express-validator");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.use(express.json());

app.post("/user", body("email").isEmail().normalizeEmail(), body("age").isInt({ min: 18 }).toInt(), (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array().map((e) => ({ path: e.path, msg: e.msg })) });
    }
    // the sanitisers wrote back, so the body carries the converted values
    res.json({ data: matchedData(req), bodyAge: req.body.age, typeofAge: typeof req.body.age });
});

app.get("/search", query("q").trim().notEmpty().withMessage("q is required"), (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ errors: errors.array().map((e) => ({ path: e.path, msg: e.msg })) });
    }
    res.json({ q: req.query.q });
});

app.get("/item/:id", param("id").isUUID().withMessage("not a uuid"), (req, res) => {
    const errors = validationResult(req);
    res.status(errors.isEmpty() ? 200 : 400).json({
        id: req.params.id,
        errors: errors.array().map((e) => e.msg)
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["POST", "/user", { email: "Someone@EXAMPLE.com", age: "42" }],
        ["POST", "/user", { email: "not an email", age: "12" }],
        ["GET", "/search?q=%20%20hello%20%20", null],
        ["GET", "/search?q=%20%20", null],
        ["GET", "/item/123e4567-e89b-12d3-a456-426614174000", null],
        ["GET", "/item/nope", null]
    ];

    for (const [method, path, payload] of cases) {
        const res = await fetchTest(`http://localhost:13333${path}`, {
            method,
            headers: payload ? { "content-type": "application/json" } : undefined,
            body: payload ? JSON.stringify(payload) : undefined
        });
        console.log(method, path, res.status, await res.text());
    }

    process.exit(0);
});
