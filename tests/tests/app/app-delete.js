// must support app.delete() and reject the removed app.del()

const express = require("express");

const app = express();

app.delete("/delete", (req, res) => {
    res.send("delete");
});

// app.del() was deprecated in Express 4 and is gone in Express 5
let delThrew = false;
try {
    app.del("/del", (req, res) => {
        res.send("del");
    });
} catch (e) {
    delThrew = true;
}
console.log("app.del threw:", delThrew);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const outputs = await Promise.all([
        fetch("http://localhost:13333/delete", { method: "DELETE" }).then((res) => res.text()),
        fetch("http://localhost:13333/del", { method: "DELETE" }).then((res) => res.status)
    ]);

    console.log(outputs);
    process.exit(0);
});
