// a router mounted inside its own tree recurses as far as the path goes, as in express. listen()
// walked into it forever and threw a RangeError before binding

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const folder = express.Router();
folder.get("/file", (req, res) => res.send("file in " + req.baseUrl));
folder.use("/sub", folder);
app.use("/folder", folder);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const p of ["/folder/file", "/folder/sub/file", "/folder/sub/sub/sub/file", "/folder/sub/nope"]) {
        const res = await fetchTest("http://localhost:13333" + p);
        console.log(p, res.status, res.status === 200 ? await res.text() : "");
    }

    process.exit(0);
});
