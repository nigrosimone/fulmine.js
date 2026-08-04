// must report an IPv4 peer of a dual stack listener in mapped form, as node does
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const app2 = express();

app.get("/test", (req, res) => {
    res.send(req.ip + " " + req.socket.remoteAddress);
});
app2.get("/test", (req, res) => {
    res.send(req.ip + " " + req.socket.remoteAddress);
});

// no host: dual stack, an IPv4 peer reads back as ::ffff:127.0.0.1
app.listen(13333, () => {
    // bound to an IPv4 address: the peer reads back plain
    app2.listen(13334, "127.0.0.1", async () => {
        let res;
        res = await fetchTest("http://127.0.0.1:13333/test");
        console.log(await res.text());

        res = await fetchTest("http://127.0.0.1:13334/test");
        console.log(await res.text());

        process.exit(0);
    });
});
