// express.compression() instead of the compression module. It takes the same options and decides
// the same way, and it served about 50% more requests per second on an 8KB JSON body here: a
// response that arrives whole is compressed in one call rather than through a transform stream,
// and goes out with a Content-Length instead of chunked. A response written in pieces still streams.
//
//   node compression.js
//   curl -sI -H "accept-encoding: br" http://localhost:3000/api/report
const express = require("fulmine.js"); // instead of require("express")

const app = express();

app.use(
    express.compression({
        // the smallest body worth compressing. Below this the header costs more than it saves
        threshold: 1024,
        // what to compress at all. The default filter is any compressible content type
        filter: (req, res) => !res.getHeader("x-no-compression") && express.compression.filter(req, res)
    })
);

app.get("/api/report", (req, res) => {
    res.json({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row ${i}` })) });
});

app.get("/api/small", (req, res) => res.json({ ok: true })); // under the threshold, sent as it is

app.listen(3000, () => console.log("http://localhost:3000/api/report"));
