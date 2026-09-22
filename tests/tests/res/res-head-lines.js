// must write every header the application set once, in the order it set them
// ASCII values only: node writes a non-ascii one as latin1, uWS as utf-8

const net = require("net");
const express = require("express");

const app = express();

// the ordinary path: a compiled route writes its own head
app.set("declarative responses", false);

// fetch sorts the headers it hands over and folds the repeats, so the head is read off a socket
function rawHead(path, connection) {
    return new Promise((resolve) => {
        const client = net.connect(13333, "127.0.0.1", () => {
            client.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: ${connection}\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString("latin1");
            const end = data.indexOf("\r\n\r\n");
            if (end !== -1) {
                client.destroy();
                resolve(data.slice(0, end));
            }
        });
    });
}

// left out, each server writes them its own way: node puts Connection, Keep-Alive and Date last,
// uWS the framing and its own mark, x-powered-by is Express only. Names lowercased, node keeps case
const THEIRS = /^(date|connection|keep-alive|content-length|transfer-encoding|x-powered-by|uwebsockets)$/;

function applicationLines(head) {
    const out = [];
    for (const line of head.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).toLowerCase();
        if (!THEIRS.test(name)) {
            out.push(name + line.slice(colon));
        }
    }
    return out;
}

app.get("/one", (req, res) => {
    res.set("X-Only", "1");
    res.end("one");
});

app.get("/two", (req, res) => {
    res.set("X-A", "1");
    res.set("X-B", "2");
    res.end("two");
});

app.get("/many", (req, res) => {
    for (let i = 0; i < 12; i++) {
        res.set("X-Line-" + i, "value " + i);
    }
    res.send("many");
});

app.get("/array-between", (req, res) => {
    res.set("X-A", "1");
    res.append("X-B", ["2", "3"]);
    res.set("X-C", "4");
    res.send("array");
});

app.get("/cookies", (req, res) => {
    res.set("X-Before", "a");
    res.cookie("one", "1");
    res.cookie("two", "2", { httpOnly: true });
    res.set("X-After", "z");
    res.send("cookies");
});

// res.set stores false for an unknown type, end() writes it as is
app.get("/unknown-type-between", (req, res) => {
    res.set("X-A", "1");
    res.set("Content-Type", "nosuchtype");
    res.set("X-B", "2");
    res.end("unknown");
});

app.get("/set-again", (req, res) => {
    res.set("X-A", "1");
    res.set("X-B", "2");
    res.set("X-C", "3");
    res.set("X-A", "again");
    res.removeHeader("X-B");
    res.set("X-B", "back");
    res.send("again");
});

app.get("/write-head", (req, res) => {
    res.writeHead(200, { "X-A": "1", "X-B": ["2", "3"], "Content-Type": "text/plain", "X-C": "4" });
    res.end("head");
});

app.get("/streamed", (req, res) => {
    res.set("X-A", "1");
    res.set("X-B", "2");
    res.set("X-C", "3");
    res.write("stre");
    res.end("amed");
});

const PATHS = [
    "/one",
    "/two",
    "/many",
    "/array-between",
    "/cookies",
    "/unknown-type-between",
    "/set-again",
    "/write-head",
    "/streamed"
];

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const connection of ["keep-alive", "close"]) {
        for (const path of PATHS) {
            console.log(connection, path, applicationLines(await rawHead(path, connection)));
        }
    }
    process.exit(0);
});
