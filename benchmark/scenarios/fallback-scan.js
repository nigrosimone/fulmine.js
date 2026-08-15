"use strict";

// Every routing scenario in the suite is answered by the native router. What none of them measured
// is the generic fallback: a request µWS cannot match byte for byte, served by scanning the
// registered routes in order. A case variant under the default insensitive routing is that shape
// in its purest form, and a regex mount or a route registered after listen serves through the same
// scan. 400 literal routes are scanned and rejected before this one matches.
module.exports = {
    name: "routing/fallback-scan",
    path: "/ROUTE400",
    setup(app) {
        for (let i = 0; i < 500; i++) {
            app.get("/route" + i, (req, res) => res.send("r" + i));
        }
    }
};
