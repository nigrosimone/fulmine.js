// must support express-fileupload middleware

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const fileUpload = require("express-fileupload");

const app = express();

app.post("/file", fileUpload(), (req, res) => {
    res.send(req.files);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const formData = new FormData();
    const file = new File([1, 2, 3], "test.txt");
    formData.append("file", file);

    const response = await fetchTest("http://localhost:13333/file", {
        method: "POST",
        body: formData
    });
    const text = await response.text();
    console.log(text);

    process.exit(0);
});
