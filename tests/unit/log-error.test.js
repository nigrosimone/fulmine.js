// The default error handler logs the error itself, as express 5.3 does, so a cause or a library's
// own fields (Sequelize's parent, an http error's status) come out; it used to log the stack alone.

const test = require("node:test");
const assert = require("node:assert");

const { logError } = require("../../src/router-utils.js");
const express = require("../../src/index.js");

/** @param {() => void} fn */
function capture(fn) {
    /** @type {unknown[][]} */
    const calls = [];
    const original = console.error;
    console.error = (...args) => {
        calls.push(args);
    };
    try {
        fn();
    } finally {
        console.error = original;
    }
    return calls;
}

test("the error goes to console.error whole, not its stack", () => {
    const app = express();
    app.set("env", "development");
    const err = new Error("outer", { cause: new Error("inner") });
    const calls = capture(() => logError(app, err));
    assert.deepStrictEqual(calls, [[err]]);
});

test("a thrown string is logged as it is", () => {
    const app = express();
    app.set("env", "development");
    const calls = capture(() => logError(app, "plain"));
    assert.deepStrictEqual(calls, [["plain"]]);
});

test("quiet under env test, and for no error", () => {
    const app = express();
    app.set("env", "test");
    assert.deepStrictEqual(
        capture(() => logError(app, new Error("x"))),
        []
    );
    app.set("env", "development");
    assert.deepStrictEqual(
        capture(() => logError(app, undefined)),
        []
    );
});
