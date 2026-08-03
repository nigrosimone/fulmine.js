// must honour the charset parameter the way body-parser does: json takes utf-* only, urlencoded
// takes utf-8 and iso-8859-1, text takes anything iconv can decode, and the rest are 415

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.post("/json", express.json(), (req, res) => res.json({ body: req.body ?? null }));
app.post("/simple", express.urlencoded({ extended: false }), (req, res) => res.json({ body: req.body }));
app.post("/ext", express.urlencoded({ extended: true }), (req, res) => res.json({ body: req.body }));
app.post("/text", express.text(), (req, res) => res.json({ body: req.body ?? null }));

app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({
        err: err.message,
        type: err.type ?? null,
        status: err.status ?? null,
        charset: err.charset ?? null
    });
});

// bodies in the charsets under test, as bytes, so the test needs no encoder of its own
const KOI8R_PRIVET = Buffer.from("f0d2c9d7c5d4", "hex"); // "Привет" in koi8-r
const WIN1251_PRIVET = Buffer.from("cff0e8e2e5f2", "hex"); // "Привет" in windows-1251
const UTF16LE_JSON = Buffer.from("fffe7b002200610022003a002200e90022007d00", "hex"); // BOM + {"a":"é"}
const UTF16BE_JSON = Buffer.from("feff007b002200610022003a002200e90022007d", "hex"); // BOM + {"a":"é"}

const post = (route, body, type) =>
    fetchTest("http://localhost:13333" + route, {
        method: "POST",
        headers: { "content-type": type },
        body
    });

app.listen(13333, async () => {
    const cases = [
        // json accepts any utf-*, refuses the rest, and an unknown utf-* is still a 415
        ["/json", KOI8R_PRIVET, "application/json; charset=koi8-r"],
        ["/json", UTF16LE_JSON, "application/json; charset=utf-16le"],
        ["/json", UTF16BE_JSON, "application/json; charset=utf-16"],
        ["/json", '{"a":"b"}', "application/json; charset=utf-8"],
        ["/json", '{"a":"b"}', "application/json; charset=utf-9"],
        // parameter names are case-insensitive, and the value may be quoted
        ["/json", '{"a":"b"}', "application/json; Charset=KOI8-R"],
        ["/json", '{"a":"b"}', 'application/json; charset="utf-8"'],
        // urlencoded allows iso-8859-1 too, and its percent escapes decode as latin1
        ["/simple", "a=%E9&b=x", "application/x-www-form-urlencoded; charset=iso-8859-1"],
        ["/ext", "a[c]=%E9", "application/x-www-form-urlencoded; charset=iso-8859-1"],
        ["/simple", "a=b", "application/x-www-form-urlencoded; charset=koi8-r"],
        // text decodes any charset iconv knows, dashless utf8 included, and 415s only the unknown
        ["/text", KOI8R_PRIVET, "text/plain; charset=koi8-r"],
        ["/text", WIN1251_PRIVET, "text/plain; charset=windows-1251"],
        ["/text", "hi there", "text/plain; charset=utf8"],
        ["/text", "hi", "text/plain; charset=x-nope"]
    ];

    for (const [route, body, type] of cases) {
        const response = await post(route, body, type);
        console.log(route, type, response.status, await response.text());
    }

    process.exit(0);
});
