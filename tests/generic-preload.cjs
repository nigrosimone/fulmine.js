// Turns the optimizer off on every app a test file makes, for the `--self` run.
//
// That run serves the same test file twice with this framework, once as written and once with this
// preloaded, and compares. Every native registration, compiled response and granted skip is a claim
// that µWS answering by itself gives the answer the ordinary chain would have given; comparing the
// two arms tests that claim against the whole comparison corpus rather than against generated
// applications, which is where the shapes nobody would think to generate already live: view
// engines, sessions, uploads, socket.io, real middleware.
//
// A divergence is a bug by construction, since the same code answered the same request two ways.
// No oracle is involved, so nothing about Express bounds what this can compare.
//
// Same shape as inspect-preload.cjs, and the same reason for being a preload: the setting has to
// reach every app a file makes, including the ones it builds inside a helper.

const Module = require("module");

const load = Module._load;

/**
 * The framework factory with the optimizer turned off on everything it makes.
 *
 * @param {any} factory the module's own export, a function carrying Router, json and the rest
 * @returns {any}
 */
function wrapFactory(factory) {
    const wrapped = function (...args) {
        const app = factory(...args);
        // one setting is enough: a compiled response needs a native registration to hang on, so it
        // goes with it
        app.set("native routes", false);
        return app;
    };
    Object.setPrototypeOf(wrapped, factory);
    Object.assign(wrapped, factory);
    return wrapped;
}

Module._load = function (request, parent, isMain) {
    const exported = load.apply(this, arguments);
    if (typeof exported !== "function" || exported.__genericWrapped) {
        return exported;
    }
    if (!(request.includes("src/index.js") && typeof exported.Router === "function")) {
        return exported;
    }
    const wrapped = wrapFactory(exported);
    wrapped.__genericWrapped = true;
    return wrapped;
};
