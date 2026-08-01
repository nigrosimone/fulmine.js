// Helpers shared by the tests.
//
// Both exist for one reason: the runner compares whatever a test prints, so anything a test does
// not print is not compared. Bodies were printed. Response headers and the request-side values
// were not, and three real faults were sitting in that gap, including an ETag that did not match
// the body it was sent with.

// Compared by value on every fetchTest call.
const COMPARED_HEADERS = [
    "content-type",
    "content-length",
    "transfer-encoding",
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

// x-powered-by is in neither list. Express sends it by default and Fulmine does not, so even its
// presence differs on purpose, and comparing it would fail on every request rather than say
// anything. It has its own test, tests/tests/settings/x-powered-by-default.js.

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
    const response = await fetch(input, init);

    const shown = [];
    for (const name of COMPARED_HEADERS) {
        // getSetCookie keeps several Set-Cookie headers apart, which get() would join
        const value = name === "set-cookie" ? response.headers.getSetCookie().join(" | ") : response.headers.get(name);
        if (value !== null && value !== "") {
            shown.push(`${name}: ${value}`);
        }
    }
    for (const name of PRESENCE_ONLY_HEADERS) {
        shown.push(`${name}: ${response.headers.has(name) ? "sent" : "absent"}`);
    }
    console.log(`[${response.status}] ${shown.join(", ")}`);

    return response;
}

/**
 * Middleware that prints the request-side values, so they are compared too.
 *
 * Mount it first with `app.use(inspectRequest)`. A plain function middleware does not stop routes
 * being compiled onto the native uWS router, which was checked before this was written: the same
 * app compiles the same number of routes with and without it.
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
