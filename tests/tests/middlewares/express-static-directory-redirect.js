// must redirect a directory to itself, and to nowhere else

const express = require("express");
const net = require("net");

// A raw socket rather than fetch, because two of these are about the path exactly as sent and
// fetch normalises a leading "//" away before the request leaves.
function raw(path) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.connect(13333, "127.0.0.1", () => {
            client.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => (data += chunk.toString()));
        client.on("close", () => {
            const status = data.split("\r\n")[0].split(" ").slice(1).join(" ");
            const location = (data.match(/^location: (.*)$/im) || [])[1];
            resolve(`${status}  location=${JSON.stringify(location ?? null)}`);
        });
    });
}

const app = express();
app.use("/mounted", express.static("tests/parts"));
app.use(express.static("tests/parts"));

app.listen(13333, async () => {
    const paths = [
        // the ordinary case
        "/subapp",
        "/mounted/subapp",

        // with a query, which has to survive: "/docs?page=3" redirecting to "/docs/" loses the page
        "/subapp?name=john",
        "/mounted/subapp?a=1&b=2",
        "/subapp?a=%20b",

        // and the one that matters most. A Location starting with "//" is a protocol-relative URL,
        // so a browser given "//subapp/" goes to the host named "subapp" instead of to this server.
        // The leading slashes are collapsed for that reason, as serve-static collapses them.
        "//subapp",
        "///subapp",
        "//subapp?a=1",

        // already has its slash, so there is nothing to redirect to
        "/subapp/"
    ];

    for (const path of paths) {
        console.log(path, await raw(path));
    }

    process.exit(0);
});
