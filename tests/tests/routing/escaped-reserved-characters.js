// a backslash makes a character path-to-regexp reserves into a literal, and the route then answers
// the path carrying it; the same character written bare is refused at registration

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

// pattern, and the path it has to answer
const escaped = [
    ["/\\(testing\\)", "/(testing)"],
    ["/a\\(b", "/a(b"],
    ["/a\\)b", "/a)b"],
    ["/a\\[b", "/a[b"],
    ["/a\\]b", "/a]b"],
    ["/a\\+b", "/a+b"],
    ["/a\\!b", "/a!b"],
    ["/a\\:b", "/a:b"],
    ["/a\\*b", "/a*b"]
];

// the same characters bare, which have a meaning the path cannot give them, plus a group nobody
// closed. Printed rather than thrown, so the two arms compare what each refuses.
const bare = ["/(testing)", "/a)b", "/a[b", "/a]b", "/a+b", "/a!b", "/a?b", "/a}b", "/a{b", "/{"];

const app = express();
app.set("etag", false);
for (const [pattern, url] of escaped) {
    app.get(pattern, (req, res) => res.send("hit " + url));
}

for (const pattern of bare) {
    try {
        express.Router().get(pattern, (req, res) => res.end());
        console.log("registers", JSON.stringify(pattern));
    } catch (err) {
        console.log("refuses ", JSON.stringify(pattern), err.message.split(";")[0]);
    }
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        escaped.map(([, url]) => async () => {
            const res = await fetchTest("http://localhost:13333" + url);
            console.log(url, res.status, await res.text());
        })
    );
    process.exit(0);
});
