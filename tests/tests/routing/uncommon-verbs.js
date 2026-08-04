// every verb node knows about has a method on the app, not only the common ones
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// the eight that were missing: the list of verbs was written out by hand and had drifted from the
// one node carries, so app.unlock was not a function while app.lock was
const VERBS = ["acl", "bind", "link", "rebind", "source", "unbind", "unlink", "unlock", "lock", "report"];

for (const verb of VERBS) {
    app[verb]("/thing", (req, res) => res.send(`${verb} answered`));
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const verb of VERBS) {
        console.log(verb, typeof app[verb]);
    }

    for (const verb of VERBS) {
        const res = await fetchTest("http://localhost:13333/thing", { method: verb.toUpperCase() });
        console.log(verb, res.status, await res.text());
    }

    process.exit(0);
});
