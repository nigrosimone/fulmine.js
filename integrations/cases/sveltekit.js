// SvelteKit through @sveltejs/adapter-node: the handler its build produces, mounted as middleware.
//
// This is a different shape from the three cases beside it. The adapter's handler does not use the
// Express request and response as an Express middleware does: it builds a web Request out of the
// node one, runs the app, and writes the web Response back with res.writeHead and res.write. So
// what is under test here is the node compatibility surface rather than the Express one, which is
// exactly the half a hand-written test would not have thought to cover.
//
// The app it serves is in apps/sveltekit, and run.js builds it before this runs.

const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13804;

/** Fetches, prints the headers, and prints the body with the build's own hashes masked. */
function ask(label, path, init) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, init);
        const text = await response.text();
        console.log(label, text.length > 400 ? `${text.length} bytes` : text);
    };
}

async function main() {
    const { handler } = await import("../apps/sveltekit/build/handler.js");
    const app = express();
    app.use(handler);
    app.listen(PORT, async () => {
        await sequential([
            // the rendered page, whose length is printed rather than its bytes: the build's asset
            // hashes are in it, and they are the same on both arms but tell nobody anything
            ask("page", "/"),
            ask("api", "/api"),
            ask("api query", "/api?tag=blue"),
            ask("api post", "/api", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ b: 2, a: 1 })
            }),
            // a body the endpoint cannot parse, so SvelteKit answers rather than the framework
            ask("api bad json", "/api", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{"
            }),
            // an error raised by the endpoint, which SvelteKit turns into its own error shape
            ask("api error", "/api?tag=boom"),
            // a method the endpoint does not export: SvelteKit's own 405, with an Allow header
            ask("api delete", "/api", { method: "DELETE" }),
            // nothing routed there, which is SvelteKit's 404 page and not Express's
            ask("missing", "/nope")
        ]);
        process.exit(0);
    });
}

main();
