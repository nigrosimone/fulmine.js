// Helpers shared by the tests.
//
// Both exist for one reason: the runner compares whatever a test prints, so anything a test does
// not print is not compared. Bodies were printed. Response headers and the request-side values
// were not, and three real faults were sitting in that gap, including an ETag that did not match
// the body it was sent with.

// Compared by value on every fetchTest call.
const COMPARED_HEADERS = [
    "content-type",
    "content-encoding",
    "content-disposition",
    "etag",
    "last-modified",
    "cache-control",
    "vary",
    "location",
    "allow",
    "accept-ranges",
    "content-range",
    "set-cookie",
    "connection"
];

// Compared by presence rather than by value. Their values differ for reasons that are not the
// framework's doing, but whether they are sent at all is still worth comparing: leaving them out
// entirely would mean neither server could ever be caught dropping one.
//   date        a timestamp, so it differs between the two runs by definition
//   keep-alive  carries each server's own idle timeout
const PRESENCE_ONLY_HEADERS = ["date", "keep-alive"];

// Three headers are in neither list, because for each of them even the presence differs for a
// reason that is not a fault:
//
//   x-powered-by                    Express sends it by default and Fulmine does not.
//   content-length, transfer-encoding
//                                   uWS frames a declarative response as chunked and writes the
//                                   Transfer-Encoding header itself, so those routes never carry
//                                   a Content-Length while Express always does. It cannot be set
//                                   from here: a response carrying both is invalid and clients
//                                   reject it outright.
//
// Both have a test of their own rather than being silently dropped:
// tests/tests/settings/x-powered-by-default.js and tests/tests/res/res-framing.js.

// Lines are printed in the order the calls were made, not the order the responses arrived. Most
// of the suite fetches concurrently through Promise.all, and printing on arrival made the output
// a race: the same test would order its lines differently on the two servers and fail for a
// reason that has nothing to do with either. The index is taken synchronously, so it follows the
// source, and a line waits until every line before it has gone out.
let nextLine = 0;
let flushedUpTo = 0;
const heldLines = new Map();

// A header value can carry an HTTP date: Set-Cookie has Expires, and anything computed from the
// clock will land a second apart between the two runs. Only the time of day is masked, so a wrong
// date, a wrong day of the week or a missing Expires still shows up.
const HTTP_TIME = /\d{2}:\d{2}:\d{2} GMT/g;

function maskClockTime(value) {
    return value.replace(HTTP_TIME, "xx:xx:xx GMT");
}

function printInCallOrder(index, line) {
    heldLines.set(index, line);
    while (heldLines.has(flushedUpTo)) {
        console.log(heldLines.get(flushedUpTo));
        heldLines.delete(flushedUpTo);
        flushedUpTo++;
    }
}

/**
 * fetch, with the response headers printed so they are compared too.
 *
 * Returns the response untouched, so a test can go on to read the body as it would have.
 *
 * @param {string|URL|Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function fetchTest(input, init) {
    const line = nextLine++;
    const response = await fetch(input, init);

    const shown = [];
    for (const name of COMPARED_HEADERS) {
        // getSetCookie keeps several Set-Cookie headers apart, which get() would join
        const value = name === "set-cookie" ? response.headers.getSetCookie().join(" | ") : response.headers.get(name);
        if (value !== null && value !== "") {
            shown.push(`${name}: ${maskClockTime(value)}`);
        }
    }
    for (const name of PRESENCE_ONLY_HEADERS) {
        shown.push(`${name}: ${response.headers.has(name) ? "sent" : "absent"}`);
    }
    printInCallOrder(line, `[${response.status}] ${shown.join(", ")}`);

    return response;
}

/**
 * Middleware that prints the request-side values, so they are compared too.
 *
 * A file asks for it with `// INSPECT` on its second line, and tests/inspect-preload.cjs mounts it
 * in front of every app that file makes. Ask for it where the request values are the point, not
 * everywhere: unlike fetchTest, which sits outside the app and costs nothing, this changes which
 * code path a route takes.
 *
 * Two separate things were measured, and only one of them is free. Native route compilation is
 * unaffected: the same app registers the same number of routes on the uWS router with and without
 * a plain middleware in front. Declarative responses are not. A route preceded by a middleware the
 * compiler cannot follow stops being compiled into a declarative response and is served by the
 * ordinary path instead, which is a different implementation with its own faults, several of them
 * found by this suite. So a test that mounts this stops covering the compiled path, and it belongs
 * in tests written for the request values rather than sprinkled across the suite.
 *
 * req.ip is deliberately absent. It depends on whether the connection arrived over IPv4 or IPv6,
 * so it would report a difference that is the machine's rather than the framework's. It has its
 * own test.
 */
function inspectRequest(req, res, next) {
    const values = [
        `method=${req.method}`,
        `url=${req.url}`,
        `originalUrl=${req.originalUrl}`,
        `baseUrl=${req.baseUrl}`,
        `path=${req.path}`,
        `protocol=${req.protocol}`,
        `secure=${req.secure}`,
        `hostname=${req.hostname}`,
        `host=${req.host}`,
        `xhr=${req.xhr}`,
        `subdomains=${JSON.stringify(req.subdomains)}`,
        `query=${JSON.stringify(req.query)}`
    ];
    console.log(`[req] ${values.join(" ")}`);
    next();
}

module.exports = { fetchTest, inspectRequest, COMPARED_HEADERS, PRESENCE_ONLY_HEADERS };
