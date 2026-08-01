// must run the listen callback after listen() has returned

const express = require("express");

const app = express();

const order = [];

// the form the Express docs use: the callback reaches the value listen() returned. It only works
// if the callback runs on a later tick, otherwise the binding is still in its dead zone.
const server = app.listen(13333, function () {
    order.push("callback");
    console.log(order.join(" -> "));
    console.log("port from inside the callback: " + server.address().port);
    // `this` is whatever listen() returned, so this reads the same on both
    console.log("port from `this`: " + this.address().port);
    process.exit(0);
});

order.push("listen returned");
