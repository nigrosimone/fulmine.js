// what the server does with bytes node's parser refuses
//
// Written through a socket rather than through fetch, because undici will not send any of this: it
// normalises the target and the header block. µWS is a different parser and hands over what node
// would have refused, so this project refuses it itself, see isAsciiTarget, endsWithChunked and
// saysClose in src/request.js.
//
// What is compared is whether the request was refused and which routes ran, not the shape of the
// refusal: express answers 400 and closes, and this closes without answering, for the reason
// _refuseRequest gives, that µWS lets the queued request through as soon as the response is
// completed rather than closed. Both are a refusal and neither serves the request, which is what
// this is here to hold.

const express = require("express");
const net = require("net");
const { sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const served = [];
app.all("/*rest", (req, res) => {
    served.push(req.method + " " + req.url);
    res.send("served");
});

const CASES = [
    ["a target with a UTF-8 e-acute in it", "GET /caf\xc3\xa9 HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["the overlong encoding of a slash", "GET /\xc0\xaf HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["a non-ascii byte in the query", "GET /a?q=\xc3\xa9 HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["chunked twice", "POST /a HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked, chunked\r\n\r\n0\r\n\r\n"],
    // legal, and the one that says the three above are refused for their own reason
    ["a plain request", "GET /plain HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["chunked once", "POST /b HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"]
];

/** Writes the bytes, waits for the socket to go quiet, and reports what came back. */
function send(bytes) {
    return new Promise((resolve) => {
        const socket = net.connect(13333, "127.0.0.1", () => socket.write(Buffer.from(bytes, "latin1")));
        let answer = "";
        const done = () => {
            socket.destroy();
            const statuses = answer.match(/HTTP\/1\.1 (\d{3})/g) || [];
            // a 400 and a close are both a refusal, and which one it is belongs to the parser
            const refused = statuses.length === 0 || statuses[0] === "HTTP/1.1 400";
            resolve(refused ? "refused" : statuses.join(" then "));
        };
        socket.setTimeout(1000, done);
        socket.on("data", (chunk) => (answer += chunk.toString("latin1")));
        socket.on("close", done);
        socket.on("error", done);
    });
}

/**
 * Sends one request, waits for its answer, and then writes a second one down the same connection.
 * A client that asked for the connection to end must not be served on it again.
 *
 * @param {string} first
 * @param {string} second
 * @returns {Promise<string>}
 */
function sendThenReuse(first, second) {
    return new Promise((resolve) => {
        const socket = net.connect(13333, "127.0.0.1", () => socket.write(first));
        let answer = "";
        let wrote = false;
        const done = () => {
            socket.destroy();
            resolve((answer.match(/HTTP\/1\.1 (\d{3})/g) || []).join(" then ") || "nothing written back");
        };
        socket.setTimeout(1000, done);
        socket.on("data", (chunk) => {
            answer += chunk.toString("latin1");
            if (!wrote && answer.includes("served")) {
                wrote = true;
                // after the answer, which is when a client would reuse the connection
                setTimeout(() => {
                    try {
                        socket.write(second);
                    } catch {
                        done();
                    }
                }, 50);
            }
        });
        socket.on("close", done);
        socket.on("error", done);
    });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const answers = await sequential(
        CASES.map(
            ([, bytes]) =>
                () =>
                    send(bytes)
        )
    );

    for (const [i, answer] of answers.entries()) {
        console.log(CASES[i][0], "->", answer);
    }

    // Connection is a list, and "keep-alive, close" ends the connection as much as "close" alone
    // does. Compared against an exact "close", this server kept the connection and served the
    // request the client sent down it afterwards.
    const reuse = await sendThenReuse(
        "GET /first HTTP/1.1\r\nHost: x\r\nConnection: keep-alive, close\r\n\r\n",
        "GET /second HTTP/1.1\r\nHost: x\r\n\r\n"
    );
    console.log("reusing a connection the client said it was done with ->", reuse);

    console.log("routes that ran:", served);

    process.exit(0);
});
