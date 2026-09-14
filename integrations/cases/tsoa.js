// tsoa: a controller written with decorators, from which `tsoa spec-and-routes` generates the
// Express routes in apps/tsoa, compiled by build.js. RegisterRoutes(app) is all a server does.
//
// The generated file reads req.params, req.query, req.headers and req.body through tsoa's own
// validation, answers with res.status().json() and hands a ValidateError to next(), so the error
// path is covered too. @tsoa/runtime lists express as a dependency but only imports its types, so
// nothing here overrides what it resolves.

const { ValidateError } = require("tsoa");
const { RegisterRoutes } = require("../apps/tsoa/build/routes.js");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13809;

/** GETs a path and prints the answer. */
function get(path, headers) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, { headers });
        console.log(await response.text());
    };
}

/** POSTs a JSON body and prints the answer. */
function post(path, body) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        });
        console.log(await response.text());
    };
}

const app = express();
app.use(express.json());
RegisterRoutes(app);
// tsoa leaves the error to the application. Express's default handler would print a stack with
// absolute paths in it, so this answers the two shapes the controller produces by hand
app.use((err, req, res, next) => {
    if (err instanceof ValidateError) {
        return res.status(422).json({ message: "validation failed", fields: err.fields });
    }
    res.status(err.status ?? 500).json({ message: err.message });
});

app.listen(PORT, async () => {
    await sequential([
        get("/items"),
        get("/items?prefix=s"),
        // a header the controller reads and echoes
        get("/items/2", { "x-trace": "abc" }),
        // the controller throws, the handler above answers its status
        get("/items/99"),
        // a path parameter that is not the number the signature declares: 422 from tsoa
        get("/items/two"),
        post("/items", { name: "terzo" }),
        get("/items"),
        // a body missing the required field, one with an empty name, and one with a field the
        // model does not declare, which throw-on-extras refuses
        post("/items", {}),
        post("/items", { name: "" }),
        post("/items", { name: "quarto", extra: true }),
        // nothing registered here, Express's own 404
        get("/nothing")
    ]);
    process.exit(0);
});
