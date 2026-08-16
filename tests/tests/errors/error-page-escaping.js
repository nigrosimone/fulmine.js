// the default error page escapes what it prints
// INSPECT
//
// An error message carries whatever raised it, and what raised it often carries something the
// client sent: a path, a header, a filename. Writing that into the page unescaped put markup from
// the request into the markup of the answer. The Content-Security-Policy on this response stops a
// script there from running, but that is the second line of defence and not the first.
// finalhandler escapes and then puts the line breaks and the indentation back as markup, and this
// compares the message rather than the whole page, since the stack below it names each project's
// own frames and can never match.
// Found by fuzzing express.static against express, where a missing file put a path into the page.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const raise = (message, status) => () => {
    const err = new Error(message);
    if (status) {
        err.status = status;
    }
    throw err;
};

app.get("/markup", raise("<script>alert(1)</script> & \"quoted\" 'single'", 400));
app.get("/entities", raise("&amp; already an entity, &lt;not a tag&gt;", 400));
app.get("/spaces", raise("two  spaces and   three", 400));
app.get("/plain", raise("nothing to escape", 400));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/markup", "/entities", "/spaces", "/plain"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        const body = await res.text();
        // the message alone: everything up to the first line break of the stack
        const message = (body.match(/<pre>([^]*?)(?:<br>|<\/pre>)/) || [])[1];
        console.log(path, res.status, JSON.stringify(message));
    }

    process.exit(0);
});
