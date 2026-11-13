// must listen with node's options object, { port, host }
//
// Express hands listen()'s arguments to node's server.listen, which takes an options object.
// Keystone starts its server that way. Fulmine threw from µWS's listen.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.get("/", (req, res) => res.send("ok"));

const server = app.listen({ port: 13333, host: "127.0.0.1" }, async (err) => {
    console.log("error:", err ?? null, "port:", server.address().port);
    const res = await fetchTest("http://127.0.0.1:13333/");
    console.log(await res.text());
    process.exit(0);
});
