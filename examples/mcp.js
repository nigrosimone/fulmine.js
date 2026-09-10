// An MCP server on the Streamable HTTP transport, with the official SDK unchanged. Express serves
// this the same way, so what is here is the shape: the POST answer leaves as an event stream and the
// GET is a response that stays open for as long as the session does.
//
//   node mcp.js   ->  http://localhost:3000/mcp
//   npx @modelcontextprotocol/inspector   ->  point it at that url, transport "Streamable HTTP"
//
// The one thing to know that Express does not ask you to: uWS does not put the head of a response on
// the wire until its first body byte, so the GET stream reads as unanswered until the server writes
// into it. The SDK's keep-alive comment frame opens it, every 15 seconds unless keepAliveMs says
// otherwise, and a notification pushed before that still arrives.
const express = require("fulmine.js"); // instead of require("express")
const { randomUUID } = require("node:crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const app = express();

// One transport per session, which is what the SDK asks for: the id it writes into the
// mcp-session-id header is how a client comes back to its own.
const sessions = new Map();

/** A server with one tool, on a transport that registers itself here once the session opens. */
function openSession() {
    const server = new McpServer({ name: "fulmine-example", version: "1.0.0" });

    server.registerTool(
        "add",
        { description: "sum two integers", inputSchema: { a: z.number().int(), b: z.number().int() } },
        ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
    );

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
        onsessionclosed: (id) => sessions.delete(id)
    });
    server.connect(transport);
    return transport;
}

/** The session this request belongs to, or a new one when it is the initialize that starts it. */
function sessionOf(req) {
    const id = req.get("mcp-session-id");
    if (id === undefined) {
        return req.method === "POST" ? openSession() : undefined;
    }
    return sessions.get(id);
}

// express.json() parses the body and the transport is handed it, which is the mounting the SDK's own
// example shows. Leaving it out works too: the transport reads the stream itself.
app.all("/mcp", express.json(), (req, res) => {
    const transport = sessionOf(req);
    if (!transport) {
        res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null
        });
        return;
    }
    transport.handleRequest(req, res, req.body);
});

app.listen(3000, () => console.log("http://localhost:3000/mcp"));
