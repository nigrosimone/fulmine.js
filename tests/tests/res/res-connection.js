// must support res.connection
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    console.log(res.writableFinished);
    console.log(res.connection.writable);
    res.end("bye", () => {
        // console.log(res.writable); // express 🐛 true forever...
        // res.socket "should be null after end()" per the node documentation, and it is here.
        // Node 26.7.0 changed when node:http detaches it: through 26.6 express answered null
        // too, and from 26.7 the socket is still there inside the callback. Printing it would
        // compare node's internal timing rather than this project's behaviour, and it moved
        // once already. https://nodejs.org/api/http.html#responsesocket
        console.log("end callback ran");
    });
    // and writableFinished right after end() reads true here and false on express from 26.7,
    // for the same reason: end() is synchronous on µWS and deferred on node
    // console.log(res.writableFinished);
    // console.log(res.connection.writable); on express is true; on ultimate is false
});

app.get("/test2", (req, res) => {
    res.end("on cb");
    console.log(res.socket !== null); // since express/node.js end is asynchronous
    setImmediate(() => {
        console.log(res.socket); // should be null
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/test");
    console.log(await response.text());

    process.exit(0);
});
