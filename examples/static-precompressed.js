// express.static({ preCompressed: true }), which is this project's own option. If your build
// already writes the .br and .gz twins next to the originals, this serves them to the clients that
// accept them: nothing is compressed at request time and a fraction of the bytes goes out. On a
// 4KB script with a brotli twin, 12 times fewer.
//
// It costs no more than serving the file itself, one stat per request, because the twin is looked
// for before the file and its own stat is the only one the request needs.
//
//   node static-precompressed.js
//   curl -sI -H "accept-encoding: br" http://localhost:3000/style.css   ->  content-encoding: br
//   curl -sI http://localhost:3000/style.css                            ->  the file itself
const express = require("fulmine.js"); // instead of require("express")
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

const dir = path.join(__dirname, "public");

// A build tool writes these. This example writes them itself so it can be run as it is
for (const name of fs.readdirSync(dir).filter((f) => !f.endsWith(".br") && !f.endsWith(".gz"))) {
    const bytes = fs.readFileSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, `${name}.br`), zlib.brotliCompressSync(bytes));
    fs.writeFileSync(path.join(dir, `${name}.gz`), zlib.gzipSync(bytes));
}

const app = express();

app.use(
    express.static(dir, {
        preCompressed: true,
        // which twins a path has is remembered for a second. "5s" widens the window, false asks
        // the disk every time. Only their presence is remembered, never a size or an mtime, so
        // nothing is ever described by a stale number
        cache: "1s",
        maxAge: "1h"
    })
);

// Vary: Accept-Encoding is sent whether or not a twin is found, the content type stays the one the
// requested name implies, and each variant carries its own ETag. A type that is already compressed,
// a woff2 or a webp, is not looked up at all.
app.listen(3000, () => console.log("http://localhost:3000/style.css"));
