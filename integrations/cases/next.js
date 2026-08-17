// Next.js as a custom server: next().getRequestHandler() mounted on an Express application.
//
// The custom server is the one integration here that is Next's own documented escape hatch rather
// than an adapter somebody wrote for Express, and it is the heaviest user of the node surface of
// the four: the handler reads the request as a stream, writes with res.writeHead and res.write, and
// asks the response about things the others never touch.
//
// The app it serves is in apps/next, and run.js builds it before this runs. Telemetry is off, since
// a request leaving the machine mid-test is not something a comparison should depend on.

process.env.NEXT_TELEMETRY_DISABLED = "1";

const path = require("node:path");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13807;
const APP = path.join(__dirname, "..", "apps", "next");

/** Fetches, prints the headers, and prints the body unless it is a whole rendered page. */
function ask(label, url, init) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${url}`, init);
        const text = await response.text();
        console.log(label, text.length > 400 ? `${text.length} bytes` : text);
    };
}

/**
 * Runs fn with everything the process writes thrown away.
 *
 * Next prints how long its config took to load, in milliseconds, which is a different number on
 * every start and would be the only line the two arms ever disagreed on. Only the startup is
 * silenced: everything the requests below print goes out normally.
 *
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function quiet(fn) {
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
        return await fn();
    } finally {
        process.stdout.write = out;
        process.stderr.write = err;
    }
}

async function main() {
    const next = require("next");
    const nextApp = next({ dev: false, dir: APP });
    await quiet(() => nextApp.prepare());
    const handle = nextApp.getRequestHandler();

    const app = express();
    app.all("/{*splat}", (req, res) => handle(req, res));
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
            // the route exports no DELETE, so Next answers 405 with an Allow header of its own
            ask("api delete", "/api/items", { method: "DELETE" }),
            // Next's own not-found page rather than Express's 404
            ask("missing", "/nope")
        ]);
        await nextApp.close();
        process.exit(0);
    });
}

main();
