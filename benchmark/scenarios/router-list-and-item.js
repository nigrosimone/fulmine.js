"use strict";

// The router of nearly every REST service: a list and an item, get("/") and get("/:id"), behind a
// middleware of its own, mounted under a prefix. LibreChat's messages and conversations are this
// shape. Until 5.25.2 each of the two blocked the other from the native router, since an empty
// segment was taken to meet a parameter, so both went the ordinary way.
//
// The request asks for an item, which is what a client opening a conversation sends.
module.exports = {
    name: "routing/router-list-and-item",
    path: "/api/messages/abc123",
    setup(app, express) {
        const messages = express.Router();
        messages.use((req, res, next) => next());
        messages.get("/", (req, res) => res.json([]));
        messages.get("/:id", (req, res) => res.json({ id: req.params.id }));
        app.use("/api/messages", messages);
    }
};
