// React Router v7 through @react-router/express: createRequestHandler over the server build.
//
// The third of the handler-shaped cases, and the one that goes through an adapter written for
// Express rather than for node: @react-router/express reads req.method, req.url, req.headers and
// pipes the request into a web Request, then writes the answer back through res.status,
// res.setHeader, res.set and the response stream. So this one lands on the Express surface where
// SvelteKit and Astro land on the node one.
//
// The app it serves is in apps/react-router, and run.js builds it before this runs.

const path = require("node:path");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13806;
const APP = path.join(__dirname, "..", "apps", "react-router");

/** Fetches, prints the headers, and prints the body unless it is a whole rendered page. */
function ask(label, path, init) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, init);
        const text = await response.text();
        console.log(label, text.length > 400 ? `${text.length} bytes` : text);
    };
}

async function main() {
    const { createRequestHandler } = await import("@react-router/express");
    const build = await import("../apps/react-router/build/server/index.js");
    const app = express();
    app.use(express.static(path.join(APP, "build", "client")));
    // the braces matter: Express 5's "/*splat" wants at least one segment, so "/" would fall
    // through to the 404 and the page would never be rendered
    app.all("/{*splat}", createRequestHandler({ build }));
    app.listen(PORT, async () => {
        await sequential([
            ask("page", "/"),
            ask("api", "/api/items"),
            ask("api query", "/api/items?tag=blue"),
            ask("api post", "/api/items", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ b: 2, a: 1 })
            }),
            ask("api bad json", "/api/items", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{"
            }),
            ask("api error", "/api/items?tag=boom"),
            // the route exports a loader and an action, so DELETE reaches the action too
            ask("api delete", "/api/items", { method: "DELETE" }),
            // an asset off the client build, served by express.static in front of the handler
            ask("asset", "/hello.txt")
            // a path no route matches is deliberately not asked for: React Router logs the miss
            // with a stack naming absolute paths, and a stack is not something two arms should be
            // compared on
        ]);
        process.exit(0);
    });
}

main();
