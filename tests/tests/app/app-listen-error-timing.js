// must report a listen error asynchronously rather than throwing out of listen()

const express = require("express");
const net = require("net");

const events = [];

function report() {
    console.log(events.join(" -> "));
    process.exit(0);
}

// with no callback there is no error listener either, so the error surfaces here and not at the
// call site
process.on("uncaughtException", (err) => {
    events.push("uncaught: " + err.code);
    report();
});

const blocker = net.createServer();
blocker.listen(13335, () => {
    const withCallback = express();

    withCallback.listen(13335, (err) => {
        events.push("callback: " + err.code);

        const withoutCallback = express();
        try {
            withoutCallback.listen(13335);
            events.push("listen returned without throwing");
        } catch (thrown) {
            events.push("threw synchronously: " + thrown.code);
            report();
        }
    });

    events.push("listen returned");
});
