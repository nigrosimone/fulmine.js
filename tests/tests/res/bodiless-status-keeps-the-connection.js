// a status that carries no content must write none, compiled or not
//
// Express drops the body and the framing headers for 204 and 304, and node writes a lone
// Content-Length of zero for 205. A compiled response wrote the body anyway, so res.sendStatus(204)
// answered "No Content" with a Content-Length of ten. A client frames a 204 as bodiless whatever
// the headers say, so those ten bytes were read as the start of the next answer on the connection:
// the request after it on a keep-alive socket got a parse error instead of its answer.
// Found by asking several requests down one connection, tools/session-fuzz.js.

const express = require("express");
const net = require("node:net");

const app = express();
app.set("etag", false);

// one callback and a constant answer, which is the shape the optimizer compiles
app.get("/send-204", (req, res) => res.sendStatus(204));
app.get("/send-304", (req, res) => res.sendStatus(304));
app.get("/send-205", (req, res) => res.sendStatus(205));
app.get("/body-204", (req, res) => res.status(204).send("body"));
app.get("/json-204", (req, res) => res.status(204).json({ a: 1 }));
app.get("/after", (req, res) => res.send("the request after it"));

/**
 * Writes requests down one connection and answers with everything that came back.
 *
 * @param {string[]} targets
 * @returns {Promise<string>}
 */
function raw(targets) {
    return new Promise((resolve) => {
        const socket = net.connect(13333, "127.0.0.1");
        let out = "";
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(out);
        };
        socket.setTimeout(1500);
        socket.on("connect", () => {
            for (const [i, target] of targets.entries()) {
                const last = i === targets.length - 1;
                socket.write(
                    `GET ${target} HTTP/1.1\r\nHost: x\r\n${last ? "Connection: close\r\n" : ""}\r\n`.replace(
                        "\r\n\r\n\r\n",
                        "\r\n\r\n"
                    )
                );
            }
        });
        socket.on("data", (chunk) => (out += chunk.toString("latin1")));
        socket.on("end", done);
        socket.on("timeout", done);
        socket.on("error", done);
        socket.on("close", done);
    });
}

/**
 * The answers as their framing, which is what this is about. What changes per run is left out, and
 * a header name is folded: express writes them through node, which capitalises, and µWS writes what
 * it is given. Every other comparison in this suite reads them through fetch, which folds them too.
 */
function framing(raw) {
    return raw
        .split("\r\n")
        .filter((line) => !/^(date|keep-alive|connection|x-powered-by|etag):/i.test(line))
        .map((line) => line.replace(/^([!#$%&'*+\-.^_`|~\w]+):/, (all, name) => name.toLowerCase() + ":"))
        .join("|")
        .replace(/\|+/g, "|");
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const target of ["/send-204", "/send-304", "/send-205", "/body-204", "/json-204"]) {
        console.log(target, framing(await raw([target])));
    }

    // the one that matters: the answer after a 204 on the same connection has to be its own
    console.log("pipelined", framing(await raw(["/send-204", "/after"])));

    process.exit(0);
});
