// Ts.ED: the application in apps/tsed, compiled by build.js, bootstrapped on @tsed/platform-express
// on one arm and on @tsed/platform-fulmine on the other. The platform is the thing tested: it owns
// the socket, the body parsers and the statics, while the routing is Ts.ED's Express adapter.
//
// The controller covers a converted path parameter, a header, a 404 thrown as an exception, ajv
// validation of a body, a form, a text body and a status set with @Returns.

const { tsedPlatform } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13812;

/** GETs a path and prints the answer. */
function get(path, headers) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, { headers });
        console.log(await response.text());
    };
}

/** POSTs a body and prints the answer. */
function post(path, type, body) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, {
            method: "POST",
            headers: { "content-type": type },
            body
        });
        console.log(await response.text());
    };
}

/** POSTs a JSON body and prints the answer. */
function postJson(path, body) {
    return post(path, "application/json", JSON.stringify(body));
}

async function main() {
    const Platform = await tsedPlatform();
    const { Server } = await import("../apps/tsed/build/Server.js");
    const platform = await Platform.bootstrap(Server, { httpPort: PORT, httpsPort: false, env: "production" });
    await platform.listen();

    await sequential([
        get("/rest/items"),
        get("/rest/items?prefix=s"),
        // the id converted to a number, and a header the controller echoes
        get("/rest/items/2", { "x-trace": "abc" }),
        // NotFound from @tsed/exceptions, answered by Ts.ED's exception filter
        get("/rest/items/99"),
        // a path parameter that is not a number: 400 from Ts.ED's converter
        get("/rest/items/two"),
        postJson("/rest/items", { name: "terzo", color: "blu" }),
        get("/rest/items"),
        // a body missing the required field and one with an empty name: ajv answers 400
        postJson("/rest/items", {}),
        postJson("/rest/items", { name: "" }),
        // malformed JSON, refused by the body parser of the platform
        post("/rest/items", "application/json", "{nope"),
        post("/rest/items/form", "application/x-www-form-urlencoded", "name=simone&city=napoli&tags[]=a&tags[]=b"),
        post("/rest/items/text", "text/plain", "ciao fulmine"),
        // a file from the statics, a conditional GET on it, and a path nothing answers
        get("/hello.txt"),
        get("/hello.txt", { "if-modified-since": new Date(Date.now() + 60000).toUTCString() }),
        get("/nothing")
    ]);

    await platform.stop();
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
