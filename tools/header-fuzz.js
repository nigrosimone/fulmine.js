// Hostile values through the response API, compared against express on the wire.
//
//   node tools/header-fuzz.js                 every value against every writer
//   node tools/header-fuzz.js --filter cookie only the writers whose name contains this
//   node tools/header-fuzz.js --verbose       print every case, not only the disagreements
//
// res.set() refuses a value that would split the response, and tests cover that. What nothing
// covered is the other door: the methods that compute a header value out of something the request
// carried. res.cookie, res.location, res.attachment and the rest all write a header nobody typed,
// and an application hands them a filename, a path or a redirect target that came from the client.
// If one of them reaches the header block without the check res.set() gets, a CRLF in that value
// ends the header and writes whatever follows as a header of its own.
//
// So this hands each of them the values that break a header block, and compares the bytes that come
// back against express. Raw sockets, because fetch parses the answer and would hide the very thing
// this is looking for: an injected line is a header to undici, not a finding.
//
// Express is the oracle here rather than node, because the question is what these methods compute,
// which is express's own behaviour and not the parser's. A disagreement either way is reported: a
// value express writes and this refuses is a compatibility bug, and the other direction is the
// injection. The list of headers left out of the comparison is the one tests/helpers.js uses, plus
// what only a wire comparison sees: date, keep-alive and connection.
//
// Every value is ASCII on purpose. Express hands a non-ascii header value to node, whose header
// block turns the character into U+FFFD and writes it as latin1, so the two differ on the wire
// while computing the same string. That is express corrupting it, and matching it would mean
// copying a fault. See tools/README.md.
//
// The cross product is a few hundred cases, so this sweeps rather than samples: there is no seed
// and no shrinking, because every case is already one line of source.

"use strict";

const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

const realExpress = require("express");
const fulmine = require(path.join(__dirname, "..", "src", "index.js"));

const CRLF = "\r\n";

const FILE_DIR = path.join(os.tmpdir(), "fulmine-header-fuzz");
const FILE = path.join(FILE_DIR, "b.json");

// what a header block cannot survive, and the things around it that are merely awkward. Written as
// escapes rather than literals so a reader can see what each one is
const VALUES = [
    ["empty", ""],
    ["plain", "plain"],
    ["space", "a b"],
    ["cr", "a\rb"],
    ["lf", "a\nb"],
    ["crlf", "a\r\nb"],
    ["crlf-header", "a\r\nX-Injected: yes"],
    ["crlf-block", "a\r\n\r\nHTTP/1.1 200 OK\r\n\r\nowned"],
    ["lf-header", "a\nX-Injected: yes"],
    ["cr-header", "a\rX-Injected: yes"],
    ["leading-crlf", "\r\nX-Injected: yes"],
    ["obs-fold", "a\r\n\tstill the same header"],
    ["nul", "a\u0000b"],
    ["tab", "a\tb"],
    ["vertical-tab", "a\u000bb"],
    ["form-feed", "a\u000cb"],
    ["del", "a\u007fb"],
    ["soh", "a\u0001b"],
    ["only-cr", "\r"],
    ["only-lf", "\n"],
    ["semicolon", "a;b"],
    ["comma", "a,b"],
    ["quote", 'a"b'],
    ["backslash", "a\\b"],
    ["apostrophe", "a'b"],
    ["equals", "a=b"],
    ["angle", "<script>alert(1)</script>"],
    ["percent-encoded-crlf", "a%0d%0aX-Injected:%20yes"],
    ["double-slash", "//evil.example/x"],
    ["scheme", "javascript:alert(1)"],
    ["traversal", "../../etc/passwd"],
    ["long", "a".repeat(2000)]
];

// Each writer takes the value from the query, which is where an application's own hostile value
// comes from. The name of that parameter is the writer's business: jsonp reads the one express
// names in its "jsonp callback name" setting.
const WRITERS = [
    { name: "cookie-value", run: (res, v) => res.cookie("k", v).end("ok") },
    { name: "cookie-name", run: (res, v) => res.cookie(v, "x").end("ok") },
    { name: "cookie-path", run: (res, v) => res.cookie("k", "x", { path: v }).end("ok") },
    { name: "cookie-domain", run: (res, v) => res.cookie("k", "x", { domain: v }).end("ok") },
    { name: "clear-cookie", run: (res, v) => res.clearCookie(v).end("ok") },
    { name: "location", run: (res, v) => res.location(v).end("ok") },
    { name: "redirect", run: (res, v) => res.redirect(v) },
    { name: "attachment", run: (res, v) => res.attachment(v).end("ok") },
    { name: "download", run: (res, v) => res.download(FILE, v, () => {}) },
    { name: "vary", run: (res, v) => res.vary(v).end("ok") },
    { name: "links", run: (res, v) => res.links({ next: v }).end("ok") },
    { name: "type", run: (res, v) => res.type(v).end("ok") },
    { name: "jsonp", param: "callback", run: (res) => res.jsonp({ ok: 1 }) },
    // the door that is already guarded, kept as the control: it must keep refusing what it refuses
    { name: "set", run: (res, v) => res.set("X-Test", v).end("ok") },
    { name: "append", run: (res, v) => res.append("X-Test", v).end("ok") }
];

/** The same application on either framework, one route per writer. */
function build(factory) {
    const app = factory();
    app.set("etag", false);
    // off on both, so the header block is the same length of list either way
    app.set("x-powered-by", false);

    for (const writer of WRITERS) {
        app.get("/" + writer.name, (req, res) => {
            const value = String(req.query[writer.param ?? "v"] ?? "");
            writer.run(res, value);
        });
    }
    // express's own error page prints its own frames, which can never match. What is compared is
    // what the two throw, which this project matches to node on purpose, see utils.headerError
    app.use((err, req, res, next) => {
        res.status(500)
            .type("txt")
            .send(`${err.code ?? "no-code"}: ${err.message}`);
    });
    return app;
}

/**
 * Writes one request and reads everything that comes back, to the end of the connection.
 *
 * @param {number} port
 * @param {string} target the request target, already encoded
 * @returns {Promise<string>} the answer as latin1, headers and body
 */
function exchange(port, target) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let out = "";
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(out);
        };
        socket.setTimeout(2000);
        socket.on("connect", () =>
            // Connection: close, so the end of the socket is the end of the answer and no timeout
            // has to stand in for it
            socket.write(`GET ${target} HTTP/1.1${CRLF}Host: x${CRLF}Connection: close${CRLF}${CRLF}`)
        );
        socket.on("data", (chunk) => (out += chunk.toString("latin1")));
        socket.on("end", done);
        socket.on("timeout", done);
        socket.on("error", done);
        socket.on("close", done);
    });
}

// what differs between the two for reasons that are not this tool's question. The first three are
// tests/helpers.js's list; the rest only exist at this level
const IGNORED = new Set(["x-powered-by", "content-length", "transfer-encoding", "date", "keep-alive", "connection"]);

/**
 * The answer as the parts worth comparing: the status line, the header lines that carry meaning,
 * and the body. Split on CRLF alone, so a bare LF inside a value stays inside its line and shows up
 * as the odd value it is rather than as another header.
 *
 * @param {string} raw
 * @returns {{status: string, headers: string[], body: string, answers: number}}
 */
function readAnswer(raw) {
    const end = raw.indexOf(CRLF + CRLF);
    const head = end === -1 ? raw : raw.slice(0, end);
    const body = end === -1 ? "" : raw.slice(end + 4);
    const lines = head.split(CRLF);
    const status = lines.shift() ?? "";
    const headers = lines
        .map((line) => {
            const colon = line.indexOf(":");
            if (colon === -1) return line;
            const name = line.slice(0, colon).trim().toLowerCase();
            return IGNORED.has(name) ? "" : `${name}:${line.slice(colon + 1).trim()}`;
        })
        .filter((line) => line !== "");
    return {
        status,
        headers: headers.sort(),
        body,
        // a value that ended the block writes a second answer into the same response. Counted in
        // the head alone: an error page quoting the value back would otherwise count as one
        answers: (head.match(/HTTP\/1\.[01] \d{3}/g) || []).length
    };
}

/** The one line a case is worth, for the report. */
function describe(answer) {
    return [answer.status, ...answer.headers, JSON.stringify(answer.body.slice(0, 120))].join(" | ");
}

async function main() {
    const argv = process.argv.slice(2);
    const filter = argv.includes("--filter") ? argv[argv.indexOf("--filter") + 1] : null;
    const verbose = argv.includes("--verbose");

    fs.mkdirSync(FILE_DIR, { recursive: true });
    fs.writeFileSync(FILE, '{"name":"b"}');

    const expressApp = build(realExpress);
    const fulmineApp = build(fulmine);
    const expressServer = await new Promise((r) => {
        const s = http.createServer(expressApp).listen(0, () => r(s));
    });
    await new Promise((r) => fulmineApp.listen(0, r));
    const expressPort = expressServer.address().port;
    const fulminePort = fulmineApp.address().port;

    const writers = WRITERS.filter((w) => !filter || w.name.includes(filter));
    console.log(`${writers.length} writers against ${VALUES.length} values, ${writers.length * VALUES.length} cases`);
    console.log(`express on ${expressPort}, fulmine on ${fulminePort}\n`);

    let checked = 0;
    let found = 0;
    for (const writer of writers) {
        for (const [label, value] of VALUES) {
            const target = `/${writer.name}?${writer.param ?? "v"}=${encodeURIComponent(value)}`;
            const expressAnswer = readAnswer(await exchange(expressPort, target));
            const fulmineAnswer = readAnswer(await exchange(fulminePort, target));
            checked++;

            const same =
                expressAnswer.status === fulmineAnswer.status &&
                expressAnswer.body === fulmineAnswer.body &&
                expressAnswer.headers.join("\n") === fulmineAnswer.headers.join("\n");

            // injection is worth saying out loud even when the two agree on it, since agreeing
            // would mean copying it
            const injected = fulmineAnswer.answers > 1 || fulmineAnswer.headers.some((h) => h.includes("x-injected"));

            if (same && !injected) {
                if (verbose) console.log(`ok   ${writer.name} ${label}`);
                continue;
            }
            found++;
            console.log(`${injected ? "INJECTED" : "differs "} ${writer.name} ${label} ${JSON.stringify(value)}`);
            console.log(`  express: ${describe(expressAnswer)}`);
            console.log(`  fulmine: ${describe(fulmineAnswer)}`);
        }
    }

    console.log(`\n${checked} cases compared, ${found} disagreements`);
    expressServer.close();
    fulmineApp.close();
    process.exit(found ? 1 : 0);
}

main();
