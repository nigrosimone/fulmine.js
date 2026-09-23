// a body parser's callback runs inside a resource an init hook saw, as raw-body's wrap makes one
// cls-hooked and OpenTelemetry's AsyncHooksContextManager carry the request context this way

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const asyncHooks = require("async_hooks");

// the resources the hook saw being made, and what each one inherited from its maker
const context = new Map();
let current;
asyncHooks
    .createHook({
        init(asyncId, type, triggerAsyncId) {
            context.set(asyncId, current);
        },
        before(asyncId) {
            current = context.get(asyncId);
        }
    })
    .enable();

const app = express();

app.use((req, res, next) => {
    current = req.get("x-request-name");
    next();
});

app.use(express.json());
app.use(express.text());

app.post("/json", (req, res) => {
    const seen = context.has(asyncHooks.executionAsyncId());
    res.json({ body: req.body, insideSeenResource: seen, context: current });
});

app.post("/text", (req, res) => {
    const seen = context.has(asyncHooks.executionAsyncId());
    res.json({ body: req.body, insideSeenResource: seen, context: current });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const json = await fetchTest("http://localhost:13333/json", {
        method: "POST",
        body: JSON.stringify({ abc: 123 }),
        headers: { "Content-Type": "application/json", "X-Request-Name": "first" }
    });
    console.log(await json.text());

    const text = await fetchTest("http://localhost:13333/text", {
        method: "POST",
        body: "some text",
        headers: { "Content-Type": "text/plain", "X-Request-Name": "second" }
    });
    console.log(await text.text());

    process.exit(0);
});
