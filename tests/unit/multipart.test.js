// express.multipart: the parser pinned case by case, then against busboy, which is what multer
// reads with, on generated bodies. Express has no counterpart, so the comparison suite cannot run it.

const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const net = require("node:net");
const busboy = require("busboy");

const express = require("../../src/index.js");
const parse = require("../../src/multipart.js");

const type = "multipart/form-data; boundary=b";
const fileHead = 'Content-Disposition: form-data; name="file"; filename="a.bin"';
const part = (head, data) => `--b\r\n${head}\r\n\r\n${data}\r\n`;
const parseText = (text, contentType = type) => parse(Buffer.from(text, "latin1"), contentType);

test("a file, a field and their metadata", () => {
    const field = part('Content-Disposition: form-data; name="a"', "1");
    const file = part(`${fileHead}\r\nContent-Type: text/plain`, "hello");
    const { fields, files } = parseText(`${field}${file}--b--\r\n`);
    assert.strictEqual(fields.a, "1");
    assert.strictEqual(fields.constructor, undefined);
    assert.deepStrictEqual(
        { ...files[0], buffer: files[0].buffer.toString() },
        {
            fieldname: "file",
            originalname: "a.bin",
            encoding: "7bit",
            mimetype: "text/plain",
            size: 5,
            buffer: "hello"
        }
    );
});

test("the boundary is read wherever and however the header writes it", () => {
    const text = `${part(fileHead, "x")}--b--\r\n`;
    for (const contentType of [
        'multipart/form-data; boundary="b"',
        "multipart/form-data; charset=utf-8; boundary=b",
        "multipart/form-data; BOUNDARY=b; charset=utf-8",
        "Multipart/Form-Data;boundary=b"
    ]) {
        assert.strictEqual(parseText(text, contentType).files.length, 1, contentType);
    }
    assert.strictEqual(parseText(text, "multipart/form-data"), null);
    assert.strictEqual(parseText(text, "multipart/form-data; boundary="), null);
});

test("a body that is not complete is refused, a part already read does not save it", () => {
    for (const text of [
        "",
        "--b\r\n",
        "--wrong--\r\n",
        part(fileHead, "x"),
        `${part(fileHead, "x")}--b`,
        `${part(fileHead, "x")}--b\r\n`,
        `${part(fileHead, "x")}--b\r\nContent-Disp`,
        `${part(fileHead, "x")}--b\r\n${fileHead}\r\n\r\nwor`,
        `--b\r\n${fileHead}\r\n\r\nhel`
    ]) {
        assert.strictEqual(parseText(text), null, JSON.stringify(text));
    }
});

test("a body with no parts, a preamble and an epilogue", () => {
    assert.deepStrictEqual(parseText("--b--\r\n").files, []);
    assert.strictEqual(parseText(`preamble\r\n${part(fileHead, "x")}--b--\r\n`).files.length, 1);
    assert.strictEqual(parseText(`${part(fileHead, "x")}--b--\r\nepilogue`).files.length, 1);
    assert.strictEqual(parseText(`--b  \t\r\n${fileHead}\r\n\r\nx\r\n--b-- \r\n`).files.length, 1);
});

test("a line of data that only starts like the delimiter stays data", () => {
    const data = "a\r\n--bc\r\n--b-x\r\nz";
    const { files } = parseText(`${part(fileHead, data)}--b--\r\n`);
    assert.strictEqual(files[0].buffer.toString(), data);
});

test("the edges of a file: empty, binary, repeated, and a filename left empty", () => {
    assert.strictEqual(parseText(`${part(fileHead, "")}--b--\r\n`).files[0].size, 0);

    const bytes = Buffer.from([0, 13, 10, 45, 45, 255]);
    const body = Buffer.concat([Buffer.from(`--b\r\n${fileHead}\r\n\r\n`), bytes, Buffer.from("\r\n--b--\r\n")]);
    assert.ok(parse(body, type).files[0].buffer.equals(bytes));

    assert.strictEqual(parseText(`${part(fileHead, "a")}${part(fileHead, "b")}--b--\r\n`).files.length, 2);

    const empty = 'Content-Disposition: form-data; name="file"; filename=""';
    const { fields, files } = parseText(`${part(empty, "x")}--b--\r\n`);
    assert.strictEqual(files.length, 0);
    assert.strictEqual(fields.file, undefined);
});

test("a file is a view on the body, nothing is copied", () => {
    const body = Buffer.from(`${part(fileHead, "hello")}--b--\r\n`);
    const { buffer } = parse(body, type).files[0];
    assert.strictEqual(buffer.buffer, body.buffer);
});

test("a repeated field is an array, and no name reaches a prototype", () => {
    const named = (name, value) => part(`Content-Disposition: form-data; name="${name}"`, value);
    const text = `${named("a", "1")}${named("a", "2")}${named("a", "3")}${named("__proto__", "x")}--b--\r\n`;
    const { fields } = parseText(text);
    assert.deepStrictEqual(fields.a, ["1", "2", "3"]);
    assert.strictEqual({}.x, undefined);
    assert.strictEqual(fields.__proto__, "x");
});

test("a part with no usable disposition is skipped", () => {
    const unnamed = part("Content-Type: text/plain", "x");
    const attachment = part("Content-Disposition: attachment; name=a", "x");
    const nameless = part('Content-Disposition: form-data; filename="a.bin"', "x");
    const { fields, files } = parseText(`${unnamed}${attachment}${nameless}--b--\r\n`);
    assert.deepStrictEqual({ ...fields }, {});
    assert.strictEqual(files.length, 0);
});

test("filenames: paths, escapes, utf-8 and filename*", () => {
    const name = (params) => {
        const body = Buffer.from(`--b\r\nContent-Disposition: form-data; name="f"; ${params}\r\n\r\nx\r\n--b--\r\n`);
        return parse(body, type).files[0]?.originalname;
    };
    assert.strictEqual(name('filename="../../etc/passwd"'), "passwd");
    assert.strictEqual(name('filename="C:\\dir\\a.txt"'), "a.txt");
    assert.strictEqual(name('filename="a\\"b.txt"'), 'a"b.txt');
    assert.strictEqual(name('filename=".."'), undefined);
    assert.strictEqual(name("filename=plain.txt"), "plain.txt");
    assert.strictEqual(name('filename="caff\u00e8.txt"'), "caff\u00e8.txt");
    assert.strictEqual(name(`filename="a.txt"; filename*=UTF-8''caff%C3%A8.txt`), "caff\u00e8.txt");
    assert.strictEqual(name(`filename="a.txt"; filename*=koi8-r''x`), "a.txt");
    assert.strictEqual(name(`filename="a.txt"; filename*=utf-8''%E0%A4%A`), "a.txt");
});

/** A deterministic generator, so a failure names a seed. */
function randomFrom(seed) {
    let state = seed;
    return (bound) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return (state >>> 8) % bound;
    };
}

function generate(seed) {
    const random = randomFrom(seed);
    const boundary = `bound-${random(1e6)}`;
    const chunks = [];
    const count = random(6);
    for (let i = 0; i < count; i++) {
        const name = `n${random(3)}`;
        const data = Buffer.alloc(random(4) === 0 ? random(3) : random(70000));
        for (let at = 0; at < data.length; at += 1 + random(40)) {
            data[at] = [13, 10, 45, 0, 255, 98][random(6)];
        }
        const isFile = random(2) === 0;
        let head = `Content-Disposition: form-data; name="${name}"`;
        if (isFile) {
            head += `; filename="f${random(9)}.bin"\r\nContent-Type: ${random(2) ? "text/plain" : "image/png"}`;
        }
        chunks.push(Buffer.from(`--${boundary}\r\n${head}\r\n\r\n`), isFile ? data : Buffer.from(String(random(1e6))));
        chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function readWithBusboy(body, contentType) {
    return new Promise((resolve, reject) => {
        const parts = [];
        const reader = busboy({ headers: { "content-type": contentType }, defParamCharset: "utf8" });
        reader.on("field", (name, value) => parts.push(["field", name, value]));
        reader.on("file", (name, stream, info) => {
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () =>
                parts.push(["file", name, info.filename, info.mimeType, Buffer.concat(chunks).toString("latin1")])
            );
        });
        reader.on("close", () => resolve(parts));
        reader.on("error", reject);
        Readable.from([body]).pipe(reader);
    });
}

test("the same parts as busboy on generated bodies", async () => {
    const sorted = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    for (let seed = 1; seed <= 400; seed++) {
        const { body, contentType } = generate(seed);
        const expected = await readWithBusboy(body, contentType);
        const { fields, files } = parse(body, contentType);

        const got = files.map((f) => ["file", f.fieldname, f.originalname, f.mimetype, f.buffer.toString("latin1")]);
        const wanted = expected.filter((row) => row[0] === "file");
        assert.deepStrictEqual(sorted(got), sorted(wanted), `files, seed ${seed}`);

        const values = Object.entries({ ...fields }).flatMap(([name, value]) =>
            [value].flat().map((text) => ["field", name, text])
        );
        const wantedValues = expected.filter((row) => row[0] === "field");
        assert.deepStrictEqual(sorted(values), sorted(wantedValues), `fields, seed ${seed}`);
    }
});

test("damaged bodies never throw, and every file stays inside the body", () => {
    for (let seed = 1; seed <= 3000; seed++) {
        const { body, contentType } = generate(seed % 40);
        const random = randomFrom(seed);
        const damaged = Buffer.from(body.subarray(0, random(4) === 0 ? random(body.length + 1) : body.length));
        for (let i = random(12); i > 0 && damaged.length > 0; i--) {
            damaged[random(damaged.length)] = random(256);
        }
        const parsed = parse(damaged, contentType);
        for (const file of parsed?.files ?? []) {
            assert.strictEqual(file.buffer.buffer, damaged.buffer, `seed ${seed}`);
            assert.ok(file.size <= damaged.length, `seed ${seed}`);
        }
    }
});

/** One raw request on a new connection. */
function send(port, head, body) {
    return new Promise((resolve, reject) => {
        let received = "";
        const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.concat([Buffer.from(head), body])));
        socket.on("data", (chunk) => (received += chunk.toString("latin1")));
        socket.on("close", () => {
            const [status] = received.split("\r\n", 1);
            const answer = received.split("\r\n\r\n").slice(1).join("\r\n\r\n");
            resolve({ status: Number(status.split(" ")[1]), body: answer });
        });
        socket.on("error", reject);
    });
}

function serve(options) {
    return new Promise((resolve) => {
        const app = express();
        app.post("/upload", express.multipart(options), (req, res) => {
            res.json({
                body: req.body === undefined ? "none" : req.body,
                files: req.files?.map((file) => [file.fieldname, file.originalname, file.buffer.toString()])
            });
        });
        app.use((err, req, res, next) => {
            res.status(err.status).send(err.type);
        });
        app.listen(0, () => resolve({ port: app.address().port, close: () => app.close() }));
    });
}

const post = (extra, length) => {
    const declared = length === undefined ? "" : `Content-Length: ${length}\r\n`;
    return `POST /upload HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${extra}${declared}\r\n`;
};

test("on a server: content-length, chunked, the limit, another type and a malformed body", async () => {
    const { port, close } = await serve({ limit: 200 });
    try {
        const field = part('Content-Disposition: form-data; name="a"', "1");
        const body = Buffer.from(`${field}${part(fileHead, "hello")}--b--\r\n`);
        const expected = JSON.stringify({ body: { a: "1" }, files: [["file", "a.bin", "hello"]] });

        const plain = await send(port, post(`Content-Type: ${type}\r\n`, body.length), body);
        assert.deepStrictEqual(plain, { status: 200, body: expected });

        const size = body.length.toString(16);
        const framed = Buffer.concat([Buffer.from(`${size}\r\n`), body, Buffer.from("\r\n0\r\n\r\n")]);
        const chunked = await send(port, post(`Content-Type: ${type}\r\nTransfer-Encoding: chunked\r\n`), framed);
        assert.strictEqual(chunked.status, 200);
        assert.ok(chunked.body.includes(expected), chunked.body);

        const large = Buffer.alloc(300, 97);
        const tooLarge = await send(port, post(`Content-Type: ${type}\r\n`, large.length), large);
        assert.deepStrictEqual(tooLarge, { status: 413, body: "entity.too.large" });

        const other = await send(port, post("Content-Type: text/plain\r\n", body.length), body);
        assert.strictEqual(JSON.parse(other.body).body, "none");

        const cut = body.subarray(0, body.length - 5);
        const malformed = await send(port, post(`Content-Type: ${type}\r\n`, cut.length), cut);
        assert.deepStrictEqual(malformed, { status: 400, body: "entity.parse.failed" });

        const noBoundary = await send(port, post("Content-Type: multipart/form-data\r\n", body.length), body);
        assert.strictEqual(noBoundary.status, 400);

        const empty = await send(port, post(`Content-Type: ${type}\r\n`, 0), Buffer.alloc(0));
        assert.strictEqual(empty.status, 400);
    } finally {
        close();
    }
});
