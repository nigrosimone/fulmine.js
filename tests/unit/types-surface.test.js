// The declarations have tsd over them, but tsd only sees what somebody thought to write down, and
// what went missing was never noticed there: `app.close()`, `res.aborted` and the whole
// http.Server surface existed at runtime and in the readme while the types said nothing, which a
// consumer only finds out when their editor refuses the line.
//
// This is the other half of that check. Every member the application, the request and the response
// carry that Express does not is either declared, in src/types.d.ts or in Express's own typings,
// or named below as internal. Adding a public member without a type fails here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const stream = require("stream");

const fulmine = require("../../src/index.js");
const express = require("express");

const root = path.join(__dirname, "..", "..");
const ownTypes = fs.readFileSync(path.join(root, "src", "types.d.ts"), "utf8");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const expressCore = read("node_modules/@types/express-serve-static-core/index.d.ts");
const nodeHttp = read("node_modules/@types/node/http.d.ts");

/**
 * Every property name reachable on an object, its prototype chain included.
 *
 * @param {any} object
 * @returns {Set<string>}
 */
function members(object) {
    const names = new Set();
    for (let o = object; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
        for (const name of Object.getOwnPropertyNames(o)) names.add(name);
    }
    return names;
}

/**
 * The body of a declaration block, so a name is looked for where it would have to be written
 * rather than anywhere in the file. `close` appears in the websocket behaviour and in node's
 * Server too, and a check that only asked "is this name in the file" called the application's
 * missing close() declared.
 *
 * @param {string} source
 * @param {string} header the line the block opens with, "interface Fulmine {"
 * @returns {string}
 */
function block(source, header) {
    let start = source.indexOf(header);
    assert.notStrictEqual(start, -1, `${header} is gone from the declarations`);
    // the header may be an opening line rather than a whole one, since Express writes its
    // interfaces with the generics on their own lines: scan on to the brace the body opens with
    start = source.indexOf("{", start + header.length) + 1;
    let depth = 1;
    for (let i = start; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) return source.slice(start, i);
    }
    throw new Error(`${header} is never closed`);
}

const applicationBlock = block(ownTypes, "interface Fulmine ");
const moduleBlock = block(ownTypes, "namespace express ");
// what this project adds to the request and the response is a global augmentation; the rest of
// their surface is Express's and node's
const augmentationBlock = block(ownTypes, "declare namespace Express ");

// and the declarations a request or a response of Express's own would carry, which is where
// everything this project did not invent has to be written
const requestSources = [
    augmentationBlock,
    block(expressCore, "export interface Request<"),
    block(nodeHttp, "class IncomingMessage ")
];
const responseSources = [
    augmentationBlock,
    block(expressCore, "export interface Response<"),
    block(nodeHttp, "class ServerResponse<"),
    block(nodeHttp, "class OutgoingMessage<")
];

/**
 * Whether a name is written down as a member of the given declarations. Deliberately loose about
 * the type itself, which is tsd's job: this only asks whether it was written down at all.
 *
 * @param {string} name
 * @param {string[]} sources
 * @returns {boolean}
 */
function declaredIn(name, sources) {
    const forms = [name + "(", name + ":", name + "?", name + ";", name + " =", "namespace " + name];
    return sources.some((source) => forms.some((form) => source.includes(form)));
}

// What is ours and internal. Everything here is reachable from an application, a request or a
// response and is deliberately undeclared: it is this project's own bookkeeping, not API. A name
// leaving this list and staying undeclared is the failure this test is for.
const INTERNAL = new Set([
    // the application's own workings
    "createRoute",
    "createWorkerTask",
    "getFullMountpath",
    "handleRequest",
    "listenCalled",
    "needsIpAfterResponse",
    "parent",
    "readFileWithWorker",
    "readSmallFile",
    "ssl",
    "workers",
    // tseep's emitter, which the application extends rather than node's
    "addListenerBound",
    "removeListenerBound",
    "hasListeners",
    "onceEvents",
    "events",
    "maxListeners",
    // the request's
    "bodyRead",
    "endsWithSlash",
    "noEtag",
    "optimizedParams",
    "parsedIp",
    "rawIp",
    "receivedData",
    "routeCount",
    "urlQuery",
    // and the response's
    "body",
    "chunkedTransfer",
    "headers",
    "statusText",
    "totalSize",
    "writeHeaders",
    "writingChunk",
    // Express 4 spellings kept as deprecated aliases, which Express 5 no longer has and this
    // project does not put in its types either
    "acceptsCharset",
    "acceptsEncoding",
    "acceptsLanguage"
]);

const IGNORED = new Set([
    "constructor",
    "apply",
    "call",
    "bind",
    "length",
    "name",
    "caller",
    "arguments",
    "prototype",
    "toString"
]);

/**
 * The members of `object` that `baseline` has no counterpart for and that nothing declares.
 *
 * @param {any} object
 * @param {Set<string>} baseline
 * @param {string[]} sources the declarations the name would have to be written in
 * @returns {string[]}
 */
function undeclaredExtras(object, baseline, sources) {
    return [...members(object)]
        .filter((name) => !baseline.has(name))
        .filter((name) => !IGNORED.has(name) && !INTERNAL.has(name))
        .filter((name) => !name.startsWith("_") && !name.startsWith("#"))
        .filter((name) => !declaredIn(name, sources))
        .sort();
}

test("every application member Express does not have is declared or listed as internal", () => {
    const app = fulmine();
    assert.deepStrictEqual(undeclaredExtras(app, members(express()), [applicationBlock]), []);
});

test("every module member Express does not have is declared", () => {
    assert.deepStrictEqual(undeclaredExtras(fulmine, members(express), [moduleBlock]), []);
});

test("every request and response member Express does not have is declared or listed as internal", async () => {
    const requestBaseline = new Set([
        ...members(express.request),
        ...members(http.IncomingMessage.prototype),
        ...members(stream.Readable.prototype)
    ]);
    const responseBaseline = new Set([
        ...members(express.response),
        ...members(http.ServerResponse.prototype),
        ...members(stream.Writable.prototype)
    ]);

    const app = fulmine();
    let extras;
    app.get("/surface", (req, res) => {
        extras = {
            request: undeclaredExtras(req, requestBaseline, requestSources),
            response: undeclaredExtras(res, responseBaseline, responseSources)
        };
        res.end("ok");
    });

    await new Promise((done) => app.listen(0, () => done()));
    await fetch(`http://127.0.0.1:${app.address().port}/surface`);
    await new Promise((done) => app.close(() => done()));

    assert.deepStrictEqual(extras, { request: [], response: [] });
});
