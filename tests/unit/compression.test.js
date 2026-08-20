// The compression module's own test suite, ported onto express.compression().
//
// It is the middleware this one replaces, so its tests are the specification: the cases, their
// names and the order they are written in are upstream's, at v1.8.1, and what changed is only the
// plumbing. Upstream builds a bare http.createServer around the middleware and drives it with
// supertest; here the middleware runs inside a real Fulmine app on a real socket, so what is
// measured is the µWS response and not node's.
//
// Four groups of upstream cases are not here, each for a reason worth naming:
//   - the HTTP/2 server, since there is none to run it against;
//   - the two back-pressure cases, which assert what a node socket does when the client stops
//     reading, and this response queues and coalesces its writes instead;
//   - "should return false writing after end", because res.end() returns the response here, as
//     Fulmine's own does, and a test of node's return value would be testing the wrong thing;
//   - "should transfer chunked" and "should remove Content-Length for chunked", which are the one
//     deliberate difference: a body that arrives whole goes out with a Content-Length instead. The
//     replacement cases below pin that, and the streaming ones still expect chunked.
//
// Upstream is MIT, Copyright (c) 2014 Jonathan Ong, Copyright (c) 2014-2015 Douglas Christopher
// Wilson. See COMPRESSION_LICENSE and NOTICE.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("node:zlib");
const express = require("../../src/index.js");

const hasBrotliSupport = "createBrotliCompress" in zlib;

/**
 * A Fulmine app with the middleware in front of one handler, listening on a free port.
 *
 * @param {any} opts what compression() is given
 * @param {(req: any, res: any) => void} fn the handler behind it
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function createServer(opts, fn) {
    const app = express();
    // upstream's servers answer with nothing but what the handler writes
    app.set("etag", false);
    app.use(express.compression(opts));
    app.use((req, res) => fn(req, res));
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            resolve({
                url: `http://127.0.0.1:${app.address().port}`,
                close: () => new Promise((done) => server.close(() => done()))
            });
        });
    });
}

/**
 * One request, with the body left exactly as it arrived on the wire: node's client does not
 * decompress unless asked, which is what lets these tests read the encoding themselves.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<{status: number, headers: any, raw: Buffer, text: string}>}
 */
function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: options.method || "GET", headers: options.headers }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const raw = Buffer.concat(chunks);
                resolve({
                    status: /** @type {number} */ (res.statusCode),
                    headers: res.headers,
                    raw,
                    text: decode(res.headers["content-encoding"], raw).toString()
                });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

/**
 * @param {string|undefined} encoding
 * @param {Buffer} body
 * @returns {Buffer}
 */
function decode(encoding, body) {
    if (body.length === 0) {
        return body;
    }
    switch (encoding) {
        case "gzip":
            return zlib.gunzipSync(body);
        case "deflate":
            return zlib.inflateSync(body);
        case "br":
            return zlib.brotliDecompressSync(body);
        default:
            return body;
    }
}

/**
 * Upstream's shouldNotHaveHeader.
 * @param {any} res
 * @param {string} header
 */
function shouldNotHaveHeader(res, header) {
    assert.ok(!(header.toLowerCase() in res.headers), "should not have header " + header);
}

/**
 * Runs one case against a server that is closed whatever the case does.
 *
 * @param {string} name
 * @param {any} opts
 * @param {(req: any, res: any) => void} handler
 * @param {(server: {url: string}) => Promise<void>} body
 */
function serverTest(name, opts, handler, body) {
    test(name, async () => {
        const server = await createServer(opts, handler);
        try {
            await body(server);
        } finally {
            await server.close();
        }
    });
}

/** The handler upstream uses almost everywhere: a short text body, sent whole. */
function helloWorld(req, res) {
    res.setHeader("Content-Type", "text/plain");
    res.end("hello, world");
}

serverTest("should skip HEAD", { threshold: 0 }, helloWorld, async (server) => {
    const res = await request(server.url, { method: "HEAD", headers: { "Accept-Encoding": "gzip" } });
    shouldNotHaveHeader(res, "Content-Encoding");
    assert.strictEqual(res.status, 200);
});

serverTest("should skip unknown accept-encoding", { threshold: 0 }, helloWorld, async (server) => {
    const res = await request(server.url, { headers: { "Accept-Encoding": "bogus" } });
    shouldNotHaveHeader(res, "Content-Encoding");
    assert.strictEqual(res.status, 200);
});

serverTest(
    "should skip if content-encoding already set",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Encoding", "x-custom");
        res.end("hello, world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "x-custom");
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest("should set Vary", { threshold: 0 }, helloWorld, async (server) => {
    const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
    assert.strictEqual(res.headers["content-encoding"], "gzip");
    assert.strictEqual(res.headers.vary, "Accept-Encoding");
});

serverTest("should set Vary even if Accept-Encoding is not set", { threshold: 0 }, helloWorld, async (server) => {
    const res = await request(server.url);
    assert.strictEqual(res.headers.vary, "Accept-Encoding");
    shouldNotHaveHeader(res, "Content-Encoding");
});

serverTest(
    "should not set Vary if Content-Type does not pass filter",
    null,
    (req, res) => {
        res.setHeader("Content-Type", "image/jpeg");
        res.end();
    },
    async (server) => {
        const res = await request(server.url);
        shouldNotHaveHeader(res, "Vary");
    }
);

serverTest("should set Vary for HEAD request", { threshold: 0 }, helloWorld, async (server) => {
    const res = await request(server.url, { method: "HEAD", headers: { "Accept-Encoding": "gzip" } });
    assert.strictEqual(res.headers.vary, "Accept-Encoding");
});

// upstream's "should transfer chunked" and "should remove Content-Length for chunked", turned
// around: a body that arrives whole is compressed in one call, so its length is known and it is
// sent as a length rather than as chunks
serverTest("should send a whole body with the compressed length", { threshold: 0 }, helloWorld, async (server) => {
    const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
    assert.strictEqual(res.headers["content-encoding"], "gzip");
    shouldNotHaveHeader(res, "Transfer-Encoding");
    assert.strictEqual(Number(res.headers["content-length"]), res.raw.length);
    assert.strictEqual(res.text, "hello, world");
});

serverTest(
    "should replace a Content-Length the handler set",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "12");
        res.end("hello, world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        assert.strictEqual(Number(res.headers["content-length"]), res.raw.length);
        assert.notStrictEqual(Number(res.headers["content-length"]), 12);
        assert.strictEqual(res.text, "hello, world");
    }
);

// and a body written in pieces still goes out chunked, since nothing knows its size in advance
serverTest(
    "should transfer chunked when the body is written in pieces",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.write("hello, ");
        res.end("world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["transfer-encoding"], "chunked");
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest(
    "should work with encoding arguments",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.write("hello, ", "utf8");
        res.end("world", "utf8");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest(
    "should transfer large bodies",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(Buffer.alloc(1000000, ".").toString());
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        assert.strictEqual(res.text.length, 1000000);
    }
);

serverTest(
    "should transfer large bodies with multiple writes",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.write(Buffer.alloc(40000, ".").toString());
        res.write(Buffer.alloc(40000, ".").toString());
        res.write(Buffer.alloc(40000, ".").toString());
        res.end(Buffer.alloc(40000, ".").toString());
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        assert.strictEqual(res.text.length, 160000);
    }
);

// threshold

serverTest(
    "should not compress responses below the threshold size",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "12");
        res.end("hello, world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        shouldNotHaveHeader(res, "Content-Encoding");
    }
);

serverTest(
    "should compress responses above the threshold size",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "2048");
        res.end(Buffer.alloc(2048));
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
    }
);

serverTest(
    "should compress when streaming without a content-length",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.write("hello, ");
        setTimeout(() => res.end("world"), 10);
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
    }
);

serverTest(
    "should not compress when streaming and content-length is lower than threshold",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "12");
        res.write("hello, ");
        setTimeout(() => res.end("world"), 10);
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        shouldNotHaveHeader(res, "Content-Encoding");
    }
);

serverTest(
    "should compress when streaming and content-length is larger than threshold",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "2048");
        res.write(Buffer.alloc(1024));
        setTimeout(() => res.end(Buffer.alloc(1024)), 10);
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
    }
);

serverTest(
    "should consider res.end() as 0 length",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end();
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        shouldNotHaveHeader(res, "Content-Encoding");
    }
);

serverTest(
    "should work with res.end(null)",
    { threshold: "1kb" },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(null);
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        shouldNotHaveHeader(res, "Content-Encoding");
        assert.strictEqual(res.status, 200);
    }
);

// negotiation

/**
 * @param {string} accept what the request offers
 * @param {string|null} expected the encoding the answer must carry, null for none
 */
function negotiationTest(accept, expected) {
    serverTest(
        `when "Accept-Encoding: ${accept}" should respond with ${expected}`,
        { threshold: 0 },
        helloWorld,
        async (server) => {
            const res = await request(server.url, { headers: { "Accept-Encoding": accept } });
            if (expected === null) {
                shouldNotHaveHeader(res, "Content-Encoding");
            } else {
                assert.strictEqual(res.headers["content-encoding"], expected);
            }
            assert.strictEqual(res.text, "hello, world");
        }
    );
}

negotiationTest("gzip", "gzip");
negotiationTest("deflate", "deflate");
negotiationTest("gzip, deflate", "gzip");
negotiationTest("deflate, gzip", "gzip");
if (hasBrotliSupport) {
    negotiationTest("br", "br");
    negotiationTest("gzip, br", "br");
    negotiationTest("deflate, gzip, br", "br");
    negotiationTest("gzip;q=1, br;q=0.3", "gzip");
    negotiationTest("gzip, br;q=0.8", "gzip");
    negotiationTest("gzip;q=0.001", "gzip");
    negotiationTest("deflate, br", "br");
}

serverTest(
    'when "Accept-Encoding: br" and passing compression level should respond with br',
    { threshold: 0, brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } } },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "br" } });
        assert.strictEqual(res.headers["content-encoding"], "br");
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest(
    "passing a brotli level should not break compression when gzip is requested",
    { threshold: 0, brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 8 } } },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        assert.strictEqual(res.text, "hello, world");
    }
);

// Cache-Control: no-transform

serverTest(
    'when "Cache-Control: no-transform" response header should not compress response',
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Cache-Control", "no-transform");
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["cache-control"], "no-transform");
        shouldNotHaveHeader(res, "Content-Encoding");
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest(
    'when "Cache-Control: no-transform" response header should not set Vary header',
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Cache-Control", "no-transform");
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["cache-control"], "no-transform");
        shouldNotHaveHeader(res, "Vary");
    }
);

// .filter

test(".filter should be a function", () => {
    assert.strictEqual(typeof express.compression.filter, "function");
});

serverTest(
    ".filter should return false on empty response",
    null,
    (req, res) => {
        res.end(express.compression.filter(req, res) ? "true" : "false");
    },
    async (server) => {
        const res = await request(server.url);
        assert.strictEqual(res.text, "false");
    }
);

serverTest(
    '.filter should return true for "text/plain"',
    null,
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(express.compression.filter(req, res) ? "true" : "false");
    },
    async (server) => {
        const res = await request(server.url);
        assert.strictEqual(res.text, "true");
    }
);

serverTest(
    '.filter should return false for "application/x-bogus"',
    null,
    (req, res) => {
        res.setHeader("Content-Type", "application/x-bogus");
        res.end(express.compression.filter(req, res) ? "true" : "false");
    },
    async (server) => {
        const res = await request(server.url);
        assert.strictEqual(res.text, "false");
    }
);

// res.flush()

serverTest(
    "res.flush() should always be present",
    null,
    (req, res) => {
        res.statusCode = typeof res.flush === "function" ? 200 : 500;
        res.flush();
        res.end();
    },
    async (server) => {
        const res = await request(server.url);
        assert.strictEqual(res.status, 200);
    }
);

/**
 * Upstream's flush cases: the handler writes one small chunk per chunk the client reads, and each
 * one has to arrive on its own rather than waiting for the next. A compressor that buffered would
 * hang here, which is the point of the test.
 *
 * @param {string} encoding
 */
function flushTest(encoding) {
    // upstream's writeAndFlush, reached from the client side: the next write only happens once the
    // previous one has arrived, so a compressor that held anything back would stop the exchange
    /** @type {() => void} */
    let next = () => {};
    serverTest(
        `res.flush() should flush small chunks for ${encoding}`,
        { threshold: 0 },
        (req, res) => {
            let writes = 0;
            next = () => {
                if (writes++ >= 2) return;
                if (writes === 2) return void res.end("..");
                res.write("..");
                res.flush();
            };
            res.setHeader("Content-Type", "text/plain");
            next();
        },
        (server) =>
            new Promise((resolve, reject) => {
                const req = http.request(server.url, { headers: { "Accept-Encoding": encoding } }, (res) => {
                    assert.strictEqual(res.headers["content-encoding"], encoding);
                    const decompressor =
                        encoding === "gzip"
                            ? zlib.createGunzip()
                            : encoding === "deflate"
                              ? zlib.createInflate()
                              : zlib.createBrotliDecompress();
                    let chunks = 0;
                    let text = "";
                    res.pipe(decompressor);
                    decompressor.on("data", (chunk) => {
                        chunks++;
                        text += chunk.toString();
                        next();
                    });
                    decompressor.on("end", () => {
                        try {
                            // two writes, each of which reached the client before the next was made
                            assert.ok(chunks >= 2, `expected at least two chunks, got ${chunks}`);
                            assert.strictEqual(text, "....");
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    });
                    decompressor.on("error", reject);
                });
                req.on("error", reject);
                req.end();
            })
    );
}

flushTest("gzip");
flushTest("deflate");
if (hasBrotliSupport) {
    flushTest("br");
}

// enforceEncoding

serverTest(
    "enforceEncoding should compress the provided encoding and not the default encoding",
    { threshold: 0, enforceEncoding: "gzip" },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "deflate" } });
        assert.strictEqual(res.headers["content-encoding"], "deflate");
    }
);

serverTest(
    "enforceEncoding should not compress when enforceEncoding is identity",
    { threshold: 0, enforceEncoding: "identity" },
    helloWorld,
    async (server) => {
        const res = await request(server.url);
        shouldNotHaveHeader(res, "Content-Encoding");
    }
);

serverTest(
    "enforceEncoding should compress when enforceEncoding is gzip",
    { threshold: 0, enforceEncoding: "gzip" },
    helloWorld,
    async (server) => {
        const res = await request(server.url);
        assert.strictEqual(res.headers["content-encoding"], "gzip");
    }
);

serverTest(
    "enforceEncoding should compress when enforceEncoding is deflate",
    { threshold: 0, enforceEncoding: "deflate" },
    helloWorld,
    async (server) => {
        const res = await request(server.url);
        assert.strictEqual(res.headers["content-encoding"], "deflate");
    }
);

if (hasBrotliSupport) {
    serverTest(
        "enforceEncoding should compress when enforceEncoding is brotli",
        { threshold: 0, enforceEncoding: "br" },
        helloWorld,
        async (server) => {
            const res = await request(server.url);
            assert.strictEqual(res.headers["content-encoding"], "br");
        }
    );
}

serverTest(
    "enforceEncoding should not compress when enforceEncoding is unknown",
    { threshold: 0, enforceEncoding: "bogus" },
    helloWorld,
    async (server) => {
        const res = await request(server.url);
        shouldNotHaveHeader(res, "Content-Encoding");
    }
);

serverTest(
    "enforceEncoding should not compress when enforceEncoding is *",
    { threshold: 0, enforceEncoding: "*" },
    helloWorld,
    async (server) => {
        const res = await request(server.url);
        shouldNotHaveHeader(res, "Content-Encoding");
    }
);

// The encodings option, which is fulmine's own: the list of what the middleware may answer with.
// Upstream has no equivalent, so these cases are not ported, they are the specification.

serverTest(
    "encodings should serve gzip although the client also offers br",
    { threshold: 0, encodings: ["gzip"] },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip, br" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest(
    "encodings should fall back to identity when the client offers none of the list",
    { threshold: 0, encodings: ["gzip"] },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "br" } });
        shouldNotHaveHeader(res, "Content-Encoding");
        assert.strictEqual(res.text, "hello, world");
    }
);

serverTest(
    "encodings absent should keep the default preference, which is br",
    { threshold: 0 },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip, br" } });
        assert.strictEqual(res.headers["content-encoding"], "br");
    }
);

serverTest(
    "encodings should still respect the client's q values inside the list",
    { threshold: 0, encodings: ["gzip", "deflate"] },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip;q=0.5, deflate;q=0.9, br" } });
        assert.strictEqual(res.headers["content-encoding"], "deflate");
    }
);

serverTest(
    "encodings of identity alone compresses nothing",
    { threshold: 0, encodings: ["identity"] },
    helloWorld,
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip, br" } });
        shouldNotHaveHeader(res, "Content-Encoding");
        assert.strictEqual(res.text, "hello, world");
    }
);

test("encodings refuses a name nobody knows, at creation and not per request", () => {
    // "zstd" used to be the example here, and stopped being one when it became an answer this
    // middleware can give. What is left has to be a name no version of it will ever take
    assert.throws(() => express.compression({ encodings: ["lzma"] }), {
        name: "TypeError",
        message: 'unknown encoding "lzma" in encodings'
    });
    assert.throws(() => express.compression({ encodings: "gzip" }), {
        name: "TypeError"
    });
});

serverTest(
    "encodings does not filter enforceEncoding, which is its own explicit choice",
    { threshold: 0, encodings: ["gzip"], enforceEncoding: "br" },
    helloWorld,
    async (server) => {
        // no Accept-Encoding at all: enforceEncoding answers, the list does not apply
        const res = await request(server.url);
        assert.strictEqual(res.headers["content-encoding"], "br");
        assert.strictEqual(res.text, "hello, world");
    }
);

// A body past SYNC_LIMIT goes to the libuv pool instead of being compressed on this thread. The
// answer has to be the same one, whichever side of that line it falls: same bytes, a
// Content-Length that describes what went out, and the callback still called.
const BIG = "x".repeat(64 * 1024);

/** @param {any} req @param {any} res */
function bigBody(req, res) {
    res.setHeader("Content-Type", "text/plain");
    res.end(BIG);
}

for (const [encoding, name] of [
    ["gzip", "gzip"],
    ["deflate", "deflate"],
    ["br", "brotli"]
]) {
    if (encoding === "br" && !hasBrotliSupport) {
        continue;
    }
    serverTest(
        `a body past the sync limit is compressed on the pool, ${name}`,
        { threshold: 0 },
        bigBody,
        async (server) => {
            const res = await request(server.url, { headers: { "Accept-Encoding": encoding } });
            assert.strictEqual(res.headers["content-encoding"], encoding);
            assert.strictEqual(res.text, BIG);
            // the length of what went out, not of what the handler wrote
            assert.strictEqual(res.headers["content-length"], String(res.raw.length));
            assert.ok(res.raw.length < BIG.length);
        }
    );
}

test("a body past the sync limit still calls end's callback", async () => {
    const server = await createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(BIG, () => {
            called = true;
        });
    });
    let called = false;
    try {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.text, BIG);
        assert.strictEqual(called, true);
    } finally {
        await server.close();
    }
});

// The middleware reads Accept-Encoding off the raw entries when the request is one of ours, and
// off req.headers when it is not. A router adopts a plain request onto our prototype, so the
// second half is for the middleware used on its own, in a node server with no router at all.
test("the middleware negotiates on a bare node request too", async () => {
    const compress = express.compression({ threshold: 0 });

    const server = http.createServer((req, res) => {
        // no router has touched this one: an IncomingMessage and nothing else
        assert.strictEqual(typeof req._foldedHeader, "undefined");
        compress(req, res, () => {
            res.setHeader("Content-Type", "text/plain");
            res.end("hello, world");
        });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
        const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
        const res = await request(url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        assert.strictEqual(res.text, "hello, world");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

serverTest(
    "res.flush before anything is written has nothing to flush",
    { threshold: 0 },
    (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        // the compression module puts flush() on every response and code calls it unasked
        res.flush();
        res.end("hello, world");
    },
    async (server) => {
        const res = await request(server.url, { headers: { "Accept-Encoding": "gzip" } });
        assert.strictEqual(res.text, "hello, world");
    }
);
