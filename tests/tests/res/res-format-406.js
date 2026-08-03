// res.format with nothing to offer is an error for the error handler, not an answer

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/thing", (req, res) => {
    res.format({
        text: () => res.send("hey"),
        html: () => res.send("<p>hey</p>"),
        json: () => res.send({ message: "hey" })
    });
});

// with a default nothing is refused, whatever was asked for
app.get("/with-default", (req, res) => {
    res.format({
        json: () => res.send({ message: "hey" }),
        default: () => res.send("anything goes")
    });
});

app.use((err, req, res, next) => {
    res.status(err.status).send(`${err.name} ${err.status} supports ${err.types.join(", ")}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [path, accept] of [
        ["/thing", "text/html"],
        ["/thing", "text/html; q=.5, text/plain"],
        ["/thing", undefined],
        ["/thing", "foo/bar"],
        ["/with-default", "foo/bar"]
    ]) {
        const res = await fetchTest(`http://localhost:13333${path}`, accept ? { headers: { Accept: accept } } : {});
        console.log(
            path,
            accept,
            res.status,
            res.headers.get("vary"),
            res.headers.get("content-type"),
            await res.text()
        );
    }

    process.exit(0);
});
