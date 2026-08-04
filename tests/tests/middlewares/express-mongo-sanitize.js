// must fail the same way express does on express-mongo-sanitize
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const mongoSanitize = require("express-mongo-sanitize");

const app = express();

app.use(express.json());
app.use(mongoSanitize());

app.post("/abc", (req, res) => {
    console.log(req.body);
    res.send("1");
});

// express-mongo-sanitize assigns to req.query, which Express 5 exposes as a getter with no setter,
// so the middleware is incompatible with v5 and throws. What this checks is that it throws here in
// exactly the same way. The class name inside the message is the one detail that cannot match,
// since the request object is not a node IncomingMessage.
app.use((err, req, res, next) => {
    console.log(err.constructor.name);
    console.log(err.message.replace(/#<\w+>/, "#<Request>"));
    res.status(500).send("sanitize failed");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/abc", {
        method: "POST",
        headers: {
            "X-ad.test": "123",
            $test: "4",
            "X-aa.bb": "5",
            "X-test": "6",
            "content-type": "application/json"
        },
        body: JSON.stringify({
            abc: 123,
            $test: "4",
            "X-aa.bb": "5",
            "X-test": "6"
        })
    });
    console.log(response.status);
    console.log(await response.text());

    process.exit(0);
});
