// two nested mounts reusing the same parameter name, which is any REST layout with :id twice

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const inner = express.Router({ mergeParams: true });
inner.get("/leaf", (req, res) => res.json(req.params));

const outer = express.Router({ mergeParams: true });
outer.use("/i/:x", inner);

app.use("/o/:x", outer);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const res = await fetchTest("http://localhost:13333/o/OUTER/i/INNER/leaf");
    console.log(res.status, await res.text());

    process.exit(0);
});
