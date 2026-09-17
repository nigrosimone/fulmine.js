// Fuzzing the wire: raw sockets, since undici never sends a malformed request, and the smuggling
// bug of 2026-08-16 (a repeated Content-Length framing the request differently) was only found by
// hand. The oracle is node's parser, llhttp, not Express: both servers record what they were asked
// to serve from the same bytes. Reported: fulmine reading a different NUMBER of requests (desync),
// or serving what node refused. Refusing what node served is only noted with --verbose, µWS may be
// stricter (SECURITY.md), not more permissive.
//
//   node tools/wire-fuzz.js [--rounds 2000] [--seed 12345] [--verbose]

"use strict";

const http = require("http");
const net = require("net");
const path = require("path");

const fulmine = require(path.join(__dirname, "..", "src", "index.js"));

/** @param {number} seed @returns {() => number} the same sequence for the same seed */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const CRLF = "\r\n";
// a Connection header asking for the close, bare or one token of a list, see closeThenPipelined
const CONNECTION_CLOSE = /connection:[^\r\n]*close/i;
// the two framing headers, captured as name and value, see canonicalisedByUws
const FRAMING_HEADER = /^(content-length|transfer-encoding):([^\r\n]*)(?=\r?\n)/gim;
// what a well-formed request looks like, appended after a malformed one so a desync is visible: if
// the server framed the first request differently from the client, this is read as a request of its
// own and served, and that is exactly what smuggling delivers
const SMUGGLED = `GET /smuggled HTTP/1.1${CRLF}Host: x${CRLF}${CRLF}`;

// The mutations, grouped by what part of the message they damage. Each is a function of the rng so
// a shape can vary without multiplying the list.
const CONTENT_LENGTHS = [
    () => "11",
    () => "0",
    () => "011",
    () => " 11",
    () => "11 ",
    () => "",
    () => "abc",
    () => "+11",
    () => "-11",
    () => "0x0b",
    () => "1e2",
    () => "11abc",
    () => "99999999999999999999",
    () => "11\t",
    () => "1 1"
];

const TRANSFER_ENCODINGS = [
    () => "chunked",
    () => "Chunked",
    () => "CHUNKED",
    () => "chunked, chunked",
    () => "identity, chunked",
    () => "chunked;a=b",
    () => "xchunked",
    () => "chunked\t",
    () => " chunked",
    () => "gzip, chunked",
    () => "chunked, gzip"
];

const BODIES = [() => '{"ok":true}', () => "", () => "x".repeat(64)];

const CHUNKED_BODIES = [
    () => `b${CRLF}{"ok":true}${CRLF}0${CRLF}${CRLF}`,
    // a size that does not match the bytes that follow
    () => `ff${CRLF}short${CRLF}0${CRLF}${CRLF}`,
    () => `0${CRLF}${CRLF}`,
    // no terminating zero chunk
    () => `b${CRLF}{"ok":true}${CRLF}`,
    // a size that is not hex
    () => `zz${CRLF}body${CRLF}0${CRLF}${CRLF}`,
    // a chunk extension, which is legal
    () => `b;name=value${CRLF}{"ok":true}${CRLF}0${CRLF}${CRLF}`,
    // a negative and an oversized size
    () => `-1${CRLF}body${CRLF}0${CRLF}${CRLF}`,
    () => `fffffffffffffff${CRLF}body${CRLF}0${CRLF}${CRLF}`,
    // trailers after the last chunk
    () => `b${CRLF}{"ok":true}${CRLF}0${CRLF}X-Trailer: v${CRLF}${CRLF}`
];

const REQUEST_LINES = [
    (p) => `POST ${p} HTTP/1.1`,
    (p) => `GET ${p} HTTP/1.1`,
    // absolute form, which a proxy sends and a server must accept
    (p) => `POST http://x${p} HTTP/1.1`,
    (p) => `POST ${p} HTTP/1.0`,
    (p) => `POST ${p} HTTP/2.0`,
    (p) => `POST ${p} HTTP/1.11`,
    (p) => `POST ${p}`,
    (p) => `POST  ${p}  HTTP/1.1`,
    (p) => `POST\t${p}\tHTTP/1.1`,
    (p) => `post ${p} HTTP/1.1`,
    (p) => ` POST ${p} HTTP/1.1`
];

const HEADER_ODDITIES = [
    () => null,
    // a continuation line, removed from HTTP/1.1 and a classic smuggling aid
    () => `X-Fold: one${CRLF}\ttwo`,
    () => `X-Fold: one${CRLF} two`,
    () => "X-Empty:",
    () => "X-Space : v",
    () => "X-Tab:\tv",
    () => `X-Dup: a${CRLF}X-Dup: b`,
    () => "Host: a" + CRLF + "Host: b",
    () => "X-Long: " + "v".repeat(2000),
    () => "X-" + "n".repeat(200) + ": v",
    () => "Connection: close",
    () => "Connection: keep-alive, close",
    () => "Expect: 100-continue"
];

const PATHS = [
    "/",
    "/a",
    "/a/b",
    "/a%00b",
    "/a%2Fb",
    "//a",
    "/a?q=1",
    "/a#f",
    "/" + "x".repeat(400),
    // A target with bytes node's parser refuses. Written as latin1 escapes because that is how the
    // socket is written: Ã© goes out as the two bytes of a UTF-8 é, and À¯ as
    // the overlong encoding of a slash, which is the oldest path traversal trick there is. µWS
    // decodes both and hands over a path that is not the bytes on the wire, so this project refuses
    // them itself, see isAsciiTarget
    "/cafÃ©",
    "/À¯",
    "/a?q=Ã©"
];

/**
 * One generated exchange: the bytes to write, and whether a well-formed request was appended.
 *
 * @param {() => number} rng
 * @returns {{bytes: string, label: string, hasSmuggled: boolean}}
 */
function drawCase(rng) {
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const chance = (p) => rng() < p;

    const path = pick(PATHS);
    const line = pick(REQUEST_LINES)(path);
    const parts = [line, "Host: x"];
    const notes = [];

    const useCL = chance(0.6);
    const useTE = chance(0.4);

    if (useCL) {
        const v = pick(CONTENT_LENGTHS)();
        parts.push(`Content-Length: ${v}`);
        notes.push(`CL=${JSON.stringify(v)}`);
        // a second one, which is the shape node refuses outright
        if (chance(0.25)) {
            const v2 = pick(CONTENT_LENGTHS)();
            parts.push(`Content-Length: ${v2}`);
            notes.push(`CL2=${JSON.stringify(v2)}`);
        }
    }
    if (useTE) {
        const v = pick(TRANSFER_ENCODINGS)();
        parts.push(`Transfer-Encoding: ${v}`);
        notes.push(`TE=${JSON.stringify(v)}`);
    }
    const odd = pick(HEADER_ODDITIES)();
    if (odd) {
        parts.push(odd);
        notes.push("odd");
    }
    if (chance(0.5)) {
        parts.push("Content-Type: application/json");
    }

    const body = useTE ? pick(CHUNKED_BODIES)() : pick(BODIES)();

    // a bare LF instead of CRLF somewhere in the head, which is the other classic framing trick
    let head = parts.join(CRLF) + CRLF + CRLF;
    if (chance(0.12)) {
        head = head.replace(CRLF, "\n");
        notes.push("bare-LF");
    }

    const hasSmuggled = chance(0.7);
    const bytes = head + body + (hasSmuggled ? SMUGGLED : "");
    // the same bytes in two writes with a pause between, cut anywhere: everything above arrives
    // in one packet, and a parser keeps state only across a cut
    const split = chance(0.3) ? Math.floor(rng() * bytes.length) : -1;
    if (split !== -1) notes.push(`split@${split}`);
    return { bytes, label: notes.join(" "), hasSmuggled, split };
}

/**
 * Whether a served count is the close-then-pipelined shape: a client that asked for the close and a
 * second request in the same packet, node answering the first and closing where µWS had already
 * parsed both out of the buffer. Asked of the run itself, and again of the control below, since a
 * case can carry this shape and the trimmed tab at once and is then the two of them together.
 *
 * @param {{bytes: string, hasSmuggled: boolean}} c
 * @param {number} nodeCount
 * @param {number} fulCount
 */
function isCloseThenPipelined(c, nodeCount, fulCount) {
    return CONNECTION_CLOSE.test(c.bytes) && c.hasSmuggled && nodeCount === 1 && fulCount === 2;
}

/**
 * The same bytes with the framing headers written the way µWS reads them, or null when nothing
 * changes: µWS trims the OWS around a value and reads a Transfer-Encoding by the coding name, so a
 * tab after a Content-Length and a parameter after "chunked" are gone before this project sees
 * them. Only those two rewrites, on a single header of each name.
 *
 * @param {string} bytes
 * @returns {string|null}
 */
function canonicalFramingBytes(bytes) {
    const seen = new Map();
    const rewritten = bytes.replace(FRAMING_HEADER, (whole, name, value) => {
        const lowered = name.toLowerCase();
        seen.set(lowered, (seen.get(lowered) ?? 0) + 1);
        const trimmed = value.trim();
        if (lowered === "content-length") {
            return /^\d+$/.test(trimmed) ? `${name}: ${trimmed}` : whole;
        }
        // the coding name on its own, which is what the comparison against "chunked" is made on
        const coding = trimmed.split(";")[0].trim();
        return coding.toLowerCase() === "chunked" ? `${name}: ${coding}` : whole;
    });
    if (rewritten === bytes || [...seen.values()].some((count) => count > 1)) {
        return null;
    }
    return rewritten;
}

/**
 * Whether two logs name the same requests in the same order, whatever each handler read of the
 * bodies: the body count is the other thing compared, and not what this question is about.
 *
 * @param {string[]} a
 * @param {string[]} b
 */
function sameRequests(a, b) {
    const request = (line) => line.replace(/ body=-?\d+$/, "");
    return a.length === b.length && a.every((line, i) => request(line) === request(b[i]));
}

/**
 * Writes bytes to a server, waits for it to go quiet, and reports what came back.
 *
 * @param {number} port
 * @param {string} bytes
 * @param {number} split where to cut the bytes into two writes, or -1 for one
 * @returns {Promise<{statuses: string[], closed: boolean, answered: boolean}>}
 */
function exchange(port, bytes, split) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let out = "";
        let closed = false;
        let settled = false;
        /** @type {NodeJS.Timeout|undefined} */
        let quiet;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(quiet);
            socket.destroy();
            const statuses = (out.match(/HTTP\/1\.[01] (\d{3})/g) || []).map((s) => s.slice(-3));
            resolve({ statuses, closed, answered: out.length > 0 });
        };
        socket.setTimeout(1200);
        socket.on("connect", () => {
            if (split === -1) {
                socket.write(Buffer.from(bytes, "latin1"));
                return;
            }
            socket.write(Buffer.from(bytes.slice(0, split), "latin1"));
            setTimeout(() => {
                if (!settled) socket.write(Buffer.from(bytes.slice(split), "latin1"));
            }, 40);
        });
        socket.on("data", (chunk) => {
            out += chunk.toString("latin1");
            clearTimeout(quiet);
            quiet = setTimeout(done, 90);
        });
        socket.on("timeout", done);
        socket.on("error", done);
        socket.on("close", () => {
            closed = true;
            setTimeout(done, 40);
        });
    });
}

/**
 * What a server was asked to serve since the last time this was called, read over a fresh
 * connection so the exchange above cannot affect it.
 *
 * @param {number} port
 * @returns {Promise<string[]>}
 */
async function drainLog(port) {
    const res = await fetch(`http://127.0.0.1:${port}/__log`, { headers: { "x-drain": "1" } });
    return res.json();
}

// the paths registered on their own, ahead of the catch-all: on this framework those are native
// routes, so the refusals a native handler makes before any routing are reached too
const LITERAL_PATHS = ["/", "/a", "/a/b"];

/**
 * One served request as the log records it: what was asked, and how many body bytes the handler
 * read, which is the second thing two parsers can disagree on out of the same bytes. Counted on
 * the stream and filled in when it ends, so a body that never ends stays at -1.
 *
 * @param {any[]} log
 * @param {any} req a node request or this framework's, both readable
 * @returns {{line: string, body: number}}
 */
function record(log, req) {
    const entry = { line: `${req.method} ${req.url}`, body: -1 };
    log.push(entry);
    let bytes = 0;
    req.on("data", (chunk) => {
        bytes += chunk.length;
    });
    req.on("end", () => {
        entry.body = bytes;
    });
    return entry;
}

/** @param {any[]} log @returns {string[]} the entries as lines, and the log emptied */
function drain(log) {
    const lines = log.map((entry) => `${entry.line} body=${entry.body}`);
    log.length = 0;
    return lines;
}

/** The node reference: the same two routes, recording what it served. */
function startNode(log) {
    const server = http.createServer((req, res) => {
        if (req.url === "/__log") {
            const body = JSON.stringify(drain(log));
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(body);
        }
        record(log, req);
        req.on("end", () => res.end("ok"));
    });
    // node answers a malformed message itself; without this it also prints to stderr
    server.on("clientError", (err, socket) => {
        try {
            socket.end(`HTTP/1.1 400 Bad Request${CRLF}Connection: close${CRLF}${CRLF}`);
        } catch {
            /* the socket may already be gone */
        }
    });
    return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

/** The same, on this framework. */
function startFulmine(log) {
    const app = fulmine();
    app.set("etag", false);
    app.get("/__log", (req, res) => {
        res.json(drain(log));
    });
    const serve = (req, res) => {
        record(log, req);
        res.send("ok");
    };
    for (const literal of LITERAL_PATHS) {
        app.all(literal, serve);
    }
    app.all("/*splat", serve);
    return new Promise((resolve) => app.listen(0, () => resolve({ server: app, port: app.address().port })));
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, fallback) => {
        const at = argv.indexOf("--" + name);
        return at === -1 ? fallback : Number(argv[at + 1]);
    };
    const rounds = flag("rounds", 400);
    const baseSeed = flag("seed", (Date.now() ^ (process.pid << 16)) >>> 0);
    const verbose = argv.includes("--verbose");

    const nodeLog = [];
    const fulLog = [];
    const nodeSrv = await startNode(nodeLog);
    const fulSrv = await startFulmine(fulLog);

    console.log(`wire fuzzing ${rounds} cases from seed ${baseSeed}`);
    console.log(`node on ${nodeSrv.port}, fulmine on ${fulSrv.port}\n`);

    let findings = 0;
    let stricter = 0;
    let canonicalised = 0;

    for (let round = 0; round < rounds; round++) {
        const seed = (baseSeed + round) >>> 0;
        const c = drawCase(mulberry32(seed));

        const nodeRes = await exchange(nodeSrv.port, c.bytes, c.split);
        const nodeServed = await drainLog(nodeSrv.port);
        const fulRes = await exchange(fulSrv.port, c.bytes, c.split);
        const fulServed = await drainLog(fulSrv.port);

        const nodeSmuggled = nodeServed.filter((s) => s.includes("/smuggled")).length;
        const fulSmuggled = fulServed.filter((s) => s.includes("/smuggled")).length;

        // Only the permissive direction is a finding, see the header. Serving fewer requests than
        // node out of the same bytes is µWS refusing something, which is safe and belongs under
        // --verbose; serving more, or serving the appended request when node did not, is the
        // desync that smuggling is made of.
        const desync = fulServed.length > nodeServed.length || fulSmuggled > nodeSmuggled;
        const morePermissive = nodeServed.length === 0 && fulServed.length > 0;
        // the same requests with different bodies: one handler was given bytes the other parser
        // gave to nobody. Only where both ended, since body=-1 is the refusing direction.
        const bodyDiffers =
            !desync &&
            fulServed.length === nodeServed.length &&
            fulServed.some(
                (line, i) => line !== nodeServed[i] && !line.endsWith("body=-1") && !nodeServed[i].endsWith("body=-1")
            );

        // µWS's own shape, kept out as the non-ascii header value is in fuzz.js: "Connection: close"
        // with a second request in the same packet, node answers the first and closes, µWS has
        // already parsed both and serves them, a bare µWS app with res.end(body, true) does the
        // same. Narrow: the close, the pipelining, and node having served the first request
        const closeThenPipelined = isCloseThenPipelined(c, nodeServed.length, fulServed.length);

        // The other µWS shape, decided 2026-09-13: a framing value µWS reads through and llhttp
        // refuses, `Content-Length: 11\t` or `Transfer-Encoding: chunked;a=b`, where the tab and
        // the parameter are gone before this project sees the value (HttpParser.h trims the OWS,
        // uWebSockets.js#1299). Checked every time it fires: the bytes rewritten the way µWS reads
        // them go back to node, which has to read the same requests this framework read
        let canonicalisedByUws = false;
        if ((desync || morePermissive) && !closeThenPipelined) {
            const canonical = canonicalFramingBytes(c.bytes);
            if (canonical !== null) {
                await exchange(nodeSrv.port, canonical, -1);
                const control = await drainLog(nodeSrv.port);
                canonicalisedByUws =
                    sameRequests(control, fulServed) || isCloseThenPipelined(c, control.length, fulServed.length);
            }
        }

        if ((desync || morePermissive || bodyDiffers) && !closeThenPipelined && !canonicalisedByUws) {
            findings++;
            console.log(`\n=== case ${round}, seed ${seed} (replay: --seed ${seed} --rounds 1)`);
            console.log(`  ${c.label || "(plain)"}${c.hasSmuggled ? " +smuggled" : ""}`);
            console.log(`  bytes:   ${JSON.stringify(c.bytes.slice(0, 160))}`);
            console.log(
                `  node:    served ${JSON.stringify(nodeServed)}  statuses ${nodeRes.statuses.join(",") || "-"}`
            );
            console.log(`  fulmine: served ${JSON.stringify(fulServed)}  statuses ${fulRes.statuses.join(",") || "-"}`);
            const why = desync
                ? "different number of requests read from the same bytes"
                : bodyDiffers
                  ? "the same requests, with a body framed differently"
                  : "served what node refused";
            console.log(`  why:     ${why}`);
        } else if (canonicalisedByUws) {
            canonicalised++;
            if (verbose) {
                console.log(
                    `  [canonicalised] case ${round}: node read the same ${fulServed.length} from the bytes as µWS spells them  ${c.label}`
                );
            }
        } else if (fulServed.length < nodeServed.length) {
            stricter++;
            if (verbose) {
                console.log(
                    `  [stricter] case ${round}: node served ${nodeServed.length}, fulmine ${fulServed.length}  ${c.label}`
                );
            }
        } else if (verbose) {
            console.log(`  [same] case ${round}: ${nodeServed.length} served  ${c.label}`);
        }
    }

    console.log(`\n${rounds} cases, ${findings} finding(s), ${stricter} where fulmine refused what node served`);
    if (!verbose && stricter) {
        console.log("those are not reported: refusing more than node is safe, --verbose lists them");
    }
    if (canonicalised) {
        console.log(`${canonicalised} where µWS read a framing value node refuses, see canonicalisedByUws`);
    }
    nodeSrv.server.close();
    fulSrv.server.close();
    setTimeout(() => process.exit(findings ? 1 : 0), 200);
}

main();
