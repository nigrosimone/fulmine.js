// test that a mounted sub-app inherits the parent's "trust proxy" unless it set its own

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const inheriting = express();
const own = express();

app.set("trust proxy", true);
own.set("trust proxy", false);

app.use("/inheriting", inheriting);
app.use("/own", own);

console.log("inheriting:", inheriting.get("trust proxy"));
console.log("own:", own.get("trust proxy"));

inheriting.get("/ip", (req, res) => res.send("ip: " + req.ip));
own.get("/ip", (req, res) => res.send("ip: " + req.ip));

app.listen(13333, async () => {
    const headers = { "X-Forwarded-For": "203.0.113.9" };
    let res = await fetchTest("http://localhost:13333/inheriting/ip", { headers });
    console.log("inheriting", await res.text());
    res = await fetchTest("http://localhost:13333/own/ip", { headers });
    // req.ip is the socket address here, which differs by machine, so only the forwarding matters
    console.log("own trusted the header:", (await res.text()) === "ip: 203.0.113.9");
    process.exit(0);
});
