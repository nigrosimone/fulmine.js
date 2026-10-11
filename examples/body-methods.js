// Express reads a body on any method, fulmine only on POST, PUT, PATCH and QUERY: reading one no
// handler wants costs about 15%. An API whose DELETE takes a JSON body names it in "body methods".
//
//   node body-methods.js
//   curl -X DELETE -H "content-type: application/json" -d '{"ids":[1,2]}' http://localhost:3000/items
const express = require("fulmine.js"); // instead of require("express")

const app = express();

// uppercase, on top of the four read by default
app.set("body methods", ["DELETE"]);

app.delete("/items", express.json(), (req, res) => {
    res.json({ deleted: req.body.ids });
});

app.listen(3000, () => console.log("http://localhost:3000/items"));
