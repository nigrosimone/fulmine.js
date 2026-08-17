// Astro through @astrojs/node in middleware mode: the handler its build exports, mounted as
// middleware.
//
// Same shape as the SvelteKit case and for the same reason: the handler reads the node request and
// writes the node response rather than using the Express surface, so what it exercises is the
// compatibility layer underneath. It differs in one thing worth having both of: Astro's handler
// takes `next`, and calls it for a path it does not answer, so an Express route after it still
// gets its turn.
//
// The app it serves is in apps/astro, and run.js builds it before this runs.

const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13805;

/** Fetches, prints the headers, and prints the body unless it is a whole rendered page. */
function ask(label, path, init) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, init);
        const text = await response.text();
        console.log(label, text.length > 400 ? `${text.length} bytes` : text);
    };
}

async function main() {
    const { handler } = await import("../apps/astro/dist/server/entry.mjs");
    const app = express();
    app.use(handler);
    // reached only because the handler called next() for a path Astro does not answer
    app.get("/after", (req, res) => res.json({ reached: true, url: req.originalUrl }));
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
            // the endpoint exports no DELETE, which Astro answers itself
            ask("api delete", "/api/items", { method: "DELETE" }),
            // Astro does not answer this one, so it calls next() and the route below it does
            ask("after", "/after"),
            // and nothing answers this one at all, which is Express's 404 rather than Astro's
            ask("missing", "/nope")
        ]);
        process.exit(0);
    });
}

main();
