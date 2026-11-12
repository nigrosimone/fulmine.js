// an added res method that reads the request still finds its headers and query
//
// A method the application adds to app.response does not take the skips from every route, only
// from the routes whose handler names it, which usage.js refuses. This is the route that does.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.response.whoami = function () {
    return this.send(`auth=${this.req.get("authorization")} q=${JSON.stringify(this.req.query)}`);
};
app.get("/test", (req, res) => res.whoami());
app.get("/plain", (req, res) => res.send("plain"));

app.listen(13333, async () => {
    const init = { headers: { authorization: "Bearer secret" } };
    console.log(await (await fetchTest("http://localhost:13333/test?a=1", init)).text());
    console.log(await (await fetchTest("http://localhost:13333/plain?a=1", init)).text());
    process.exit(0);
});
