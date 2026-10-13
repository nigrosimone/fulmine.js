// Colyseus with express routes beside a room. The Express arm is Colyseus's default, Express on
// node:http through WebSocketTransport; the Fulmine arm is the uWS transport with fulmine.js/colyseus.

const http = require("http");
const { defineServer, Room } = require("@colyseus/core");
const { Client } = require("@colyseus/sdk");
const { arm, express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13810;

class EchoRoom extends Room {
    onCreate() {
        this.onMessage("ping", (client, message) => client.send("pong", message));
    }
}

/** @param {any} app */
function routes(app) {
    app.use(express.json());
    app.get("/hello", (req, res) => res.json({ hello: "world" }));
    app.get("/users/:id", (req, res) => res.json({ id: req.params.id, q: req.query.q }));
    app.post("/echo", (req, res) => res.json(req.body));
}

let transport;
let expressOption;
if (arm === "fulmine") {
    const { FulmineTransport } = require("fulmine.js/colyseus");
    transport = new FulmineTransport();
    expressOption = routes;
} else {
    const { WebSocketTransport } = require("@colyseus/ws-transport");
    const app = express();
    routes(app);
    transport = new WebSocketTransport({ server: http.createServer(app) });
}

const server = defineServer({ greet: false, transport, rooms: { echo: EchoRoom }, express: expressOption });

server.listen(PORT).then(async () => {
    const base = `http://localhost:${PORT}`;
    const origin = { headers: { origin: "http://game.example" } };
    await sequential(
        [
            ["GET", "/hello"],
            ["GET", "/users/7?q=x"],
            ["POST", "/echo", { a: 1, b: [2, 3] }],
            ["GET", "/missing"]
        ].map(([method, path, body]) => async () => {
            const res = await fetchTest(base + path, {
                method,
                headers: { ...origin.headers, ...(body ? { "content-type": "application/json" } : {}) },
                body: body ? JSON.stringify(body) : undefined
            });
            // the CORS headers Colyseus adds to the express answers, not in fetchTest's list
            console.log(method, path, res.headers.get("access-control-allow-origin"), (await res.text()).length);
        })
    );
    // answered by Colyseus itself, which on the uWS transport writes no Connection or Keep-Alive
    const health = await fetch(base + "/__healthcheck");
    console.log("GET /__healthcheck", health.status, await health.text());
    const client = new Client(base.replace("http", "ws"));
    const room = await client.joinOrCreate("echo");
    const pong = new Promise((resolve) => room.onMessage("pong", resolve));
    room.send("ping", 42);
    console.log("room pong", await pong);
    await room.leave();
    process.exit(0);
});
