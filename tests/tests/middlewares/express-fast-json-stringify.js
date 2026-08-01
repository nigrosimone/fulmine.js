// must support express-fast-json-stringify

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const { fastJsonSchema } = require("express-fast-json-stringify");

const app = express();

const schema = {
    title: "Example Schema",
    type: "object",
    properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        age: { type: "integer" }
    }
};

app.get("/user", fastJsonSchema(schema), (req, res) => {
    res.fastJson({ firstName: "Simone", lastName: "Nigro", age: 40 });
});

// a status other than 200 has to travel with the serialized body
app.get("/created", fastJsonSchema(schema), (req, res) => {
    res.status(201).fastJson({ firstName: "a", lastName: "b", age: 1 });
});

// properties outside the schema are dropped, which is the point of compiling it
app.get("/extra", fastJsonSchema(schema), (req, res) => {
    res.fastJson({ firstName: "x", lastName: "y", age: 2, secret: "should not appear" });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/user", "/created", "/extra"]) {
        const response = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, response.status, response.headers.get("content-type"));
        console.log(await response.text());
    }

    process.exit(0);
});
