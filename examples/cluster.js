// One node process uses one core, and this is the setting that changes it. Each worker binds the
// same port with uWS's shared flag, which is SO_REUSEPORT: every process has its own listening
// socket and the kernel decides which one gets each connection, so the primary is not in the path
// at all. On a 16-core machine that is close to 16 times the throughput.
//
//   node cluster.js
//   curl http://localhost:3000/who   (a different pid on most requests)
const express = require("fulmine.js"); // instead of require("express")

// "auto" is one worker per usable core: the cgroup quota is read first, so a 2-core container on
// a 64-core host forks 2 and not 64. A number instead of "auto" says how many
const app = express({ cluster: "auto" });

let served = 0;

app.get("/who", (req, res) => {
    // Anything held per process is now held per worker: this counter, an in-memory cache, a
    // rate-limit counter, a session store. Sharing one needs Redis or something like it
    res.json({ pid: process.pid, servedByThisWorker: ++served });
});

// The whole file runs again in every worker, which is how cluster works, so the lines above run
// once per process. The primary only forks, so this callback runs once per worker too, and a
// worker that dies is replaced. app.close() in the primary stops them all, and a SIGTERM or
// SIGINT that reaches only the primary, which is what a container sends, is passed on
app.listen(3000, () => console.log(`worker ${process.pid} listening on 3000`));
