// issue-304

const express = require("express");

const app1 = express();
const app2 = express();

process.on("uncaughtException", (err) => {
    console.log({ error: err.message });
    process.exit(0);
});

app1.listen(13333, (token1) => {
    console.log({ token1 });

    // listening on a port that is already taken has to reach the callback rather than crash the
    // process. Only the code and message are printed: the stack necessarily differs between
    // implementations and is not what this is about.
    app2.listen(13333, (token2) => {
        console.log({ code: token2?.code, message: token2?.message });
        process.exit(0);
    });
});
