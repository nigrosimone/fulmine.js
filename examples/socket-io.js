// socket.io normally takes over the upgrade on a node http.Server. There is no node server here,
// so hand it the uWS app instead, which socket.io supports natively through attachApp().
//
//   node socket-io.js   ->  http://localhost:3000
//
// What does not work is new Server(app), or new Server(app.listen(...)), which is the same object:
// socket.io refuses it with "You are trying to attach socket.io to an express request handler
// function", because it checks for a function before it checks for a server and an app here is
// callable. That refusal is the useful answer, since there would be no node socket behind it.
const express = require("fulmine.js"); // instead of require("express")
const { Server } = require("socket.io");

const app = express();
const io = new Server();

app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>socket.io</title>
<pre id="log"></pre>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  socket.on("reply", (data) => (log.textContent += data + "\\n"));
  socket.emit("message", "hello from the browser");
</script>`);
});

app.listen(3000, () => console.log("http://localhost:3000"));

// before or after listen(), both work
io.attachApp(app.uwsApp);

io.on("connection", (socket) => {
    socket.on("message", (data) => socket.emit("reply", `you said: ${data}`));
});
