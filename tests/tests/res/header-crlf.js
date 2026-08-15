// must refuse a header name or value that would break the response apart, as node does

// A CR or an LF in a header value ends the header early on the wire, and everything after it is
// read by the client as another header, or as another response entirely. Node refuses them from
// setHeader, so Express does too, and an application echoing a query value into res.set relies on
// that without knowing it. uWS writes what it is given, so the check has to happen here.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// built rather than written: a literal NUL or DEL in this file does not survive being edited
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

// each one is what an application would do with a value that came from the request
const vectors = {
    "value CRLF": (res, bad) => res.set("x-echo", bad),
    "value LF": (res) => res.set("x-echo", "a\nx-injected: yes"),
    "value NUL": (res) => res.set("x-echo", `a${NUL}b`),
    "value DEL": (res) => res.set("x-echo", `a${DEL}b`),
    "name CRLF": (res, bad) => res.set(bad, "v"),
    "name space": (res) => res.set("x y", "v"),
    "array entry": (res, bad) => res.set("x-arr", ["fine", bad]),
    append: (res, bad) => res.append("x-app", bad),
    type: (res) => res.type("text/plain\r\nx-injected: yes"),
    links: (res) => res.links({ next: "http://x/\r\nx-injected: yes" }),
    "setHeader undefined": (res) => res.setHeader("x-undef", undefined),
    // the two that must still go through: a high byte and a tab are legal in a value
    "high bytes ok": (res) => res.set("x-echo", "café"),
    "tab ok": (res) => res.set("x-echo", "a\tb")
};

app.get("/:vector", (req, res) => {
    const run = vectors[req.params.vector];
    let outcome = "no throw";
    try {
        run(res, "a\r\nx-injected: yes");
    } catch (err) {
        outcome = `${err.code} ${err.name}: ${err.message}`;
    }
    // read back off the response, so a value that got in without throwing is reported even where
    // the wire happens not to show it
    res.json({ outcome, stored: res.getHeader("x-echo") ?? res.getHeader("x-arr") ?? null });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const name of Object.keys(vectors)) {
        const response = await fetchTest(`http://localhost:13333/${encodeURIComponent(name)}`);
        console.log(name, await response.text());
        console.log("  injected header on the wire:", response.headers.get("x-injected"));
    }

    process.exit(0);
});
