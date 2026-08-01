"use strict";

module.exports = {
    name: "middlewares/body-urlencoded",
    path: "/abc",
    load: {
        connections: 200
    },
    request: {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "name=ultimate&value=express&feature=benchmark&count=12345"
    },
    setup(app, express) {
        app.use(express.urlencoded({ extended: false }));
        app.post("/abc", (req, res) => {
            res.send(`${Object.keys(req.body).length}`);
        });
    }
};
