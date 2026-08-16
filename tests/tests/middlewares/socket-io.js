// must support socket.io
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const { Server } = require("socket.io");
const { io } = require("socket.io-client");

const app = express();

app.get("/http", (req, res) => res.send("http still works"));

const sio = new Server();
sio.on("connection", (socket) => {
    socket.on("ping-me", (msg) => {
        socket.emit("pong-me", "got: " + msg);
    });
});

const server = app.listen(13333);

// Express hands socket.io a node http.Server and lets it take over the upgrade. The upgrade never
// reaches node here, so socket.io attaches to the uWS app instead, which it supports natively.
if (app.uwsApp) {
    sio.attachApp(app.uwsApp);
} else {
    sio.attach(server);
}

// and the wrong way round, which answers the same on both: an application is a callable, and
// socket.io looks for a function before it looks for a server. It refuses out loud rather than
// attaching to something that would never hand it an upgrade.
try {
    new Server(app);
    console.log("attaching to the app: accepted");
} catch (err) {
    console.log("attaching to the app:", err.message);
}

(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));

    console.log(await fetchTest("http://localhost:13333/http").then((res) => res.text()));

    const client = io("http://localhost:13333", { transports: ["websocket"] });
    const reply = await new Promise((resolve) => {
        client.on("connect", () => client.emit("ping-me", "hello"));
        client.on("pong-me", (message) => resolve(message));
        client.on("connect_error", (err) => resolve("connect_error: " + err.message));
        setTimeout(() => resolve("TIMEOUT"), 5000);
    });
    console.log(reply);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(0);
})();
