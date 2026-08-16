// Mounts helpers.inspectRequest in front of every app of a test file, so the request-side values
// are compared across the whole suite and not only in the one file written for them.
//
// A preload rather than a line in each test, and an opt-in run rather than the default one, for
// the reason written on inspectRequest itself: a middleware in front of a route stops that route
// from being compiled into a declarative response, so the normal run would lose the coverage of
// the compiled path. Monkey-patching res.send instead would be worse, not better: the compiler
// refuses to compile anything once a response method differs from the one it knows, so a patch
// turns the whole app off rather than the routes behind one middleware.
//
// Both arms load it, so express and fulmine print the same lines and the comparison stays fair.
//
// Three kinds of file must not ask for it, and each of them fails quietly rather than loudly:
//
//   a file testing the compiled path    the middleware is what stops a route being compiled, so
//                                       the file would still pass while testing the other path
//   a file setting a routing flag       this mounts before the file's own app.set() runs, and both
//                                       frameworks freeze "strict routing" and "case sensitive
//                                       routing" the first time a route is registered. The two
//                                       arms still agree, so the file passes, but it is now
//                                       testing loose routing while its name says strict
//   a file fetching concurrently        the [req] line is printed when the request arrives, and
//                                       Promise.all lets the arrivals race. fetchTest orders its
//                                       own lines by taking an index at call time, which nothing
//                                       running server side can do

const Module = require("module");
const { inspectRequest } = require("./helpers.js");

const load = Module._load;

/**
 * The express (or fulmine) factory with the inspector mounted on everything it makes.
 *
 * @param {any} factory the module's own export, a function carrying Router, json and the rest
 * @returns {any}
 */
function wrapFactory(factory) {
    const wrapped = function (...args) {
        const app = factory(...args);
        app.use(inspectRequest);
        return app;
    };
    Object.setPrototypeOf(wrapped, factory);
    Object.assign(wrapped, factory);
    return wrapped;
}

Module._load = function (request, parent, isMain) {
    const exported = load.apply(this, arguments);
    if (typeof exported !== "function" || exported.__inspectWrapped) {
        return exported;
    }
    const isFramework =
        request === "express" || (request.includes("src/index.js") && typeof exported.Router === "function");
    if (!isFramework) {
        return exported;
    }
    const wrapped = wrapFactory(exported);
    wrapped.__inspectWrapped = true;
    return wrapped;
};
