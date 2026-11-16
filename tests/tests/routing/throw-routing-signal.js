// a thrown or rejected "route" or "router" is next("route") or next("router"), as router 2 forwards
// it, not an error
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.get("/throw", () => {
    throw "route";
});
app.get("/throw", (req, res) => res.send("after throw"));
app.get("/reject", async () => {
    throw "route";
});
app.get("/reject", (req, res) => res.send("after reject"));
app.get(
    "/handler",
    (req, res, next) => next(new Error("boom")),
    (err, req, res, next) => {
        throw "route";
    }
);
app.get("/handler", (req, res) => res.send("after handler"));
app.get(
    "/handler-reject",
    (req, res, next) => next(new Error("boom")),
    async (err, req, res, next) => {
        throw "route";
    }
);
app.get("/handler-reject", (req, res) => res.send("after handler reject"));

const router = express.Router();
router.use(() => {
    throw "router";
});
router.get("/inner", (req, res) => res.send("never"));
app.use("/mounted", router);
app.get("/mounted/inner", (req, res) => res.send("after router"));

app.get(
    "/zero",
    () => {
        throw 0;
    },
    (req, res) => res.send("after zero")
);

app.use((err, req, res, next) => {
    res.status(500).send(`handled ${String(err)}`);
});

app.listen(13333, async () => {
    await sequential(
        ["/throw", "/reject", "/handler", "/handler-reject", "/mounted/inner", "/zero"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, await res.text());
        })
    );
    process.exit(0);
});
