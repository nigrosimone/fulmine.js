// a replaced res.send that reads the request still finds its headers and query
//
// The header and query skips are granted by reading the handler, and res.send("ok") reads nothing.
// A method the application put on app.response was never read, so it found no authorization and
// an empty query.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.response.send = function (body) {
    this.set("content-type", "text/plain");
    return this.end(`${body} auth=${this.req.get("authorization")} q=${JSON.stringify(this.req.query)}`);
};
app.get("/test", (req, res) => res.send("ok"));

app.listen(13333, async () => {
    const res = await fetchTest("http://localhost:13333/test?a=1", { headers: { authorization: "Bearer secret" } });
    console.log(await res.text());
    process.exit(0);
});
