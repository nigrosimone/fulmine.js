// must reject a chunked body over the limit without responding twice

const express = require("express");

const app = express();

app.use(express.json({ limit: "20b" }));

app.post("/abc", (req, res) => {
    res.json({ ok: true });
});

app.use((err, req, res, next) => {
    res.status(413).json({ tooLarge: true });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    // a streamed body arrives in several chunks and carries no content-length,
    // so the limit can only be caught while reading
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"aaaaaaaaaa":'));
            controller.enqueue(new TextEncoder().encode('"bbbbbbbbbbbbbbbbbbbb"}'));
            controller.close();
        }
    });

    const response = await fetch("http://localhost:13333/abc", {
        method: "POST",
        body,
        duplex: "half",
        headers: {
            "Content-Type": "application/json"
        }
    });

    console.log(response.status);
    console.log(await response.text());

    // the server must still be answering after rejecting the oversized body
    const after = await fetch("http://localhost:13333/abc", {
        method: "POST",
        body: '{"a":1}',
        headers: {
            "Content-Type": "application/json"
        }
    });
    console.log(after.status);
    console.log(await after.text());

    process.exit(0);
});
