// must reject app.param(fn) and keep app.param(name, fn) working

const express = require("express");

const app = express();

// app.param(callback) was the deprecated handler-factory form in Express 4, removed in Express 5
let paramFnThrew = false;
try {
    app.param(function (name, fn) {
        return fn;
    });
} catch (e) {
    paramFnThrew = true;
}
console.log("app.param(fn) threw:", paramFnThrew);

// the two-argument form is the one that survives
app.param("itemId", function (req, res, next, val) {
    console.log("param handler for itemId:", val);
    next();
});

app.get("/item/:itemId", function (req, res) {
    console.log("itemId param:", req.params.itemId);
    res.send("item route");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetch("http://localhost:13333/item/abc");
    console.log("status:", response.status);
    console.log(await response.text());

    process.exit(0);
});
