// res.end() of a chunk that is not a string, a Buffer or a Uint8Array: node throws
// ERR_INVALID_ARG_TYPE with the value named in the message, and a falsy chunk is sent as nothing

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const chunks = {
    number: 123,
    object: { o: 1 },
    array: [1, 2],
    boolean: true,
    "array-buffer": new ArrayBuffer(2),
    zero: 0,
    false: false,
    null: null,
    empty: ""
};

const app = express();
for (const [name, chunk] of Object.entries(chunks)) {
    app.get("/" + name, (req, res) => res.end(chunk));
}
app.use((err, req, res, next) => res.status(500).type("txt").send(`${err.code}: ${err.message}`));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        Object.keys(chunks).map((name) => async () => {
            const res = await fetchTest("http://localhost:13333/" + name);
            console.log(name, res.status, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
