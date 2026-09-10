// MCP through @modelcontextprotocol/sdk: a server on the Streamable HTTP transport, asked by the
// SDK's own client and then by hand.
//
// This reaches a corner no other case here does. The node transport turns the request into a
// web-standard Request with @hono/node-server and writes the answer back with writeHead and
// res.write, and every answer leaves as text/event-stream, so what is compared is the request
// stream, the chunked write and a response held open while the server pushes into it.
//
// Three endpoints because the transport is mounted three ways in the wild: reading the body off the
// stream itself, taking it already parsed from express.json(), and answering what never reaches a
// session at all.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { z } = require("zod");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13808;
const BASE = `http://localhost:${PORT}`;

// What the SDK asks for on a POST, and what a client that forgets it is refused for.
const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * An MCP server with a tool, a resource and a prompt, on a transport of its own.
 *
 * The session id is fixed instead of a UUID: it goes out in a header and comes back on every later
 * request, and two random ones would be the only thing the two arms differ by.
 *
 * @param {string} session the session id this transport hands out
 * @param {number} keepAliveMs 0 turns the keep-alive comment frames off
 * @returns {Promise<any>} the transport, already connected to its server
 */
async function mcp(session, keepAliveMs) {
    const server = new McpServer({ name: "fulmine-case", version: "1.0.0" });

    // zod because registerTool takes nothing else: a plain JSON Schema is refused before the
    // server starts, whatever validation provider is installed
    server.registerTool(
        "add",
        { description: "sum two integers", inputSchema: { a: z.number().int(), b: z.number().int() } },
        (/** @type {any} */ args) => ({ content: [{ type: "text", text: String(args.a + args.b) }] })
    );

    server.registerResource("item", "item://1", { mimeType: "text/plain" }, () => ({
        contents: [{ uri: "item://1", mimeType: "text/plain", text: "primo" }]
    }));

    server.registerPrompt("greet", { description: "say hello" }, () => ({
        messages: [{ role: "user", content: { type: "text", text: "ciao" } }]
    }));

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => session, keepAliveMs });
    await server.connect(transport);
    return transport;
}

/**
 * Everything the SDK's own client asks of one endpoint, printed as it comes back.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
async function throughTheClient(path) {
    const client = new Client({ name: "fulmine-case-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}${path}`)));

    console.log(`${path} server:`, JSON.stringify(client.getServerVersion()));
    console.log(`${path} tools:`, JSON.stringify(await client.listTools()));
    console.log(`${path} call:`, JSON.stringify(await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })));

    // arguments the schema refuses
    try {
        console.log(
            `${path} bad args:`,
            JSON.stringify(await client.callTool({ name: "add", arguments: { a: 2, b: "three" } }))
        );
    } catch (error) {
        console.log(`${path} bad args threw:`, /** @type {Error} */ (error).message);
    }

    // a tool that was never registered
    try {
        console.log(`${path} no such tool:`, JSON.stringify(await client.callTool({ name: "nope", arguments: {} })));
    } catch (error) {
        console.log(`${path} no such tool threw:`, /** @type {Error} */ (error).message);
    }

    console.log(`${path} resources:`, JSON.stringify(await client.listResources()));
    console.log(`${path} read:`, JSON.stringify(await client.readResource({ uri: "item://1" })));
    console.log(`${path} prompt:`, JSON.stringify(await client.getPrompt({ name: "greet" })));

    // close sends the DELETE that ends the session, so nothing may use this endpoint after here
    await client.close();
}

/**
 * The keep-alive comment frames taken out of a stream.
 *
 * They are on a timer, so how many landed before the message the test was waiting for is the clock's
 * business and not something the two arms have to agree on.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutKeepAlive(text) {
    return text.split(": keepalive\n\n").join("");
}

/**
 * POSTs one JSON-RPC message by hand and prints the bytes that came back.
 *
 * @param {string} path
 * @param {any} body an object to send as JSON, or a string to send as it is
 * @param {Record<string,string>} [headers]
 * @returns {() => Promise<void>}
 */
function post(path, body, headers) {
    return async () => {
        const response = await fetchTest(`${BASE}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: MCP_ACCEPT, ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body)
        });
        console.log(`${path} body:`, JSON.stringify(withoutKeepAlive(await response.text())));
    };
}

/**
 * The `initialize` every session starts with.
 *
 * @param {number} id
 * @returns {object}
 */
function initialize(id) {
    return {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "by-hand", version: "1.0.0" }
        }
    };
}

/**
 * Opens the standalone GET stream, has the server push a notification into it, and prints what
 * arrived. This is the held-open response: it is written from a later tick, long after the handler
 * that opened it returned.
 *
 * The endpoint this runs against is the one with a short keep-alive, and it has to be. uWS does not
 * put the head of a response on the wire until its first body byte, so a stream nobody has written
 * into yet has not answered at all and the fetch below would never resolve: the comment frame is
 * what opens it. res.flushHeaders in src/response.js says the same thing and why it cannot be fixed
 * here.
 *
 * The text is printed once it is whole rather than chunk by chunk, because where the boundaries fall
 * is the server's own business and not something the two arms have to agree on.
 *
 * @param {string} path
 * @param {string} session
 * @param {any} transport
 * @returns {Promise<void>}
 */
async function standaloneStream(path, session, transport) {
    const abort = new AbortController();
    const response = await fetchTest(`${BASE}${path}`, {
        headers: { accept: "text/event-stream", "mcp-session-id": session },
        signal: abort.signal
    });

    const pushed = transport.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "pushed from a later tick" }
    });

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("notifications/message")) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    await pushed;
    abort.abort();
    console.log(`${path} stream:`, JSON.stringify(withoutKeepAlive(text)));
}

/**
 * A bare request, for the probes that are about the status and not about a body.
 *
 * @param {string} label
 * @param {string} path
 * @param {RequestInit} init
 * @returns {() => Promise<void>}
 */
function bare(label, path, init) {
    return async () => {
        const response = await fetchTest(`${BASE}${path}`, init);
        console.log(`${path} ${label}:`, JSON.stringify(await response.text()));
    };
}

async function main() {
    const streamed = await mcp("session-streamed", 0);
    const parsed = await mcp("session-parsed", 0);
    const probed = await mcp("session-probed", 0);
    const held = await mcp("session-held", 50);

    const app = express();
    // the body left on the stream for the transport to read itself
    app.post("/mcp", (req, res) => streamed.handleRequest(req, res));
    app.get("/mcp", (req, res) => streamed.handleRequest(req, res));
    app.delete("/mcp", (req, res) => streamed.handleRequest(req, res));
    // the body already parsed and handed over, which is what the SDK's own example shows
    app.post("/parsed", express.json(), (req, res) => parsed.handleRequest(req, res, req.body));
    app.get("/parsed", (req, res) => parsed.handleRequest(req, res));
    app.delete("/parsed", (req, res) => parsed.handleRequest(req, res));
    app.post("/probe", (req, res) => probed.handleRequest(req, res));
    app.get("/probe", (req, res) => probed.handleRequest(req, res));
    app.delete("/probe", (req, res) => probed.handleRequest(req, res));
    // the stream the server pushes into, see standaloneStream for why this one keeps its keep-alive
    app.post("/held", (req, res) => held.handleRequest(req, res));
    app.get("/held", (req, res) => held.handleRequest(req, res));

    app.listen(PORT, async () => {
        await throughTheClient("/mcp");
        await throughTheClient("/parsed");

        await sequential([
            // the refusals, none of which reach a session
            post("/probe", initialize(1), { accept: "application/json" }),
            post("/probe", initialize(1), { "content-type": "text/plain" }),
            post("/probe", "{ not json"),
            post("/probe", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            bare("no session", "/probe", { headers: { accept: "text/event-stream" } }),
            // a session by hand, and then one on the endpoint that holds a stream open
            post("/probe", initialize(1)),
            post("/held", initialize(1)),
            () => standaloneStream("/held", "session-held", held),
            bare("delete", "/probe", { method: "DELETE", headers: { "mcp-session-id": "session-probed" } }),
            // and the same DELETE again, now that the session is gone
            bare("delete again", "/probe", { method: "DELETE", headers: { "mcp-session-id": "session-probed" } })
        ]);

        process.exit(0);
    });
}

main();
