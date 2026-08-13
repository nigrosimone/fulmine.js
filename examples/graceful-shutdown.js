// app.listen() returns the app rather than a separate server object, and the app answers as an
// http.Server: instanceof is true, which is what the graceful shutdown wrappers and the connection
// trackers look for. There is still no node server underneath, the socket belongs to uWS, so what
// is answered is the surface and not the plumbing.
//
//   node graceful-shutdown.js   then Ctrl-C, or kill the pid
const express = require("fulmine.js"); // instead of require("express")
const http = require("http");

const app = express();

app.get("/slow", (req, res) => setTimeout(() => res.send("done"), 2000));

const server = app.listen(3000, () => console.log("http://localhost:3000/slow"));

console.log("instanceof http.Server:", server instanceof http.Server); // true
console.log("the same object as the app:", server === app); // true
console.log("address:", app.address(), "listening:", app.listening);

// There: close(), address(), listening, getConnections(), ref(), unref(), setTimeout() and the
// keepAliveTimeout family. Not there: nothing emits "connection", "request" or "upgrade",
// getConnections() counts the requests in flight rather than sockets, and the timeouts belong to
// uWS and are set through uwsOptions.idleTimeout.
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        app.getConnections((err, count) => console.log(`${count} request(s) in flight`));
        // stops accepting, and calls back when what is in flight has been answered
        app.close(() => {
            console.log("closed");
            process.exit(0);
        });
    });
}
