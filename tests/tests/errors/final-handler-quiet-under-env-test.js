// the final handler prints the error it answers with, unless env is test

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

// what the final handler prints goes to stderr, which the runner does not compare, so it is
// collected here and printed on stdout instead. Only the first line, since the frames below it
// are the two frameworks' own and are not the same file
const logged = [];
console.error = (...args) => logged.push(String(args[0]).split("\n")[0]);

const quiet = express();
quiet.set("env", "test");
quiet.set("etag", false);
quiet.get("/boom", () => {
    throw new Error("quiet one");
});

const loud = express();
loud.set("env", "development");
loud.set("etag", false);
loud.get("/boom", () => {
    throw new Error("loud one");
});

quiet.listen(13333, () => {
    loud.listen(13334, async () => {
        // the body is left unread: it carries the stack, whose frames are each framework's own
        await sequential([
            () => fetchTest("http://localhost:13333/boom"),
            () => fetchTest("http://localhost:13334/boom")
        ]);
        // express logs from the setImmediate finalhandler schedules, so it lands after the answer
        setTimeout(() => {
            console.log(logged);
            process.exit(0);
        }, 100);
    });
});
