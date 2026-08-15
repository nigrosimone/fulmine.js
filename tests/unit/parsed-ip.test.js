// req.ip, from the sixteen bytes µWS hands over.
//
// A dual stack listener reports every IPv4 peer as ::ffff:a.b.c.d, so that shape is read straight
// out of the bytes instead of going through the general formatter. It is worth about 157ns on every
// request that reads req.ip, which morgan does on every line it writes, and it is only worth
// anything if it answers exactly what the general path answered: this pins both, on the shapes that
// take the shortcut and on the ones that must not.

const test = require("node:test");
const assert = require("node:assert");

const Request = require("../../src/request.js");

function bytesOf(...values) {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < values.length; i++) {
        bytes[i] = values[i];
    }
    return bytes;
}

/** the sixteen bytes of an IPv4-mapped address */
function mapped(a, b, c, d) {
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes[12] = a;
    bytes[13] = b;
    bytes[14] = c;
    bytes[15] = d;
    return bytes;
}

/** the sixteen bytes of an address written as eight groups */
function groups(...values) {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        bytes[i * 2] = (values[i] ?? 0) >> 8;
        bytes[i * 2 + 1] = (values[i] ?? 0) & 0xff;
    }
    return bytes;
}

function ipOf(bytes) {
    const req = {
        getUrl: () => "/",
        getMethod: () => "get",
        getCaseSensitiveMethod: () => "GET",
        getQuery: () => undefined,
        getHeader: () => "",
        getParameter: () => "",
        forEach: () => {},
        setYield: () => {}
    };
    const res = {
        onAborted: () => {},
        finished: false,
        getRemoteAddressAsText: () => Buffer.from("127.0.0.1"),
        getRemoteAddress: () => bytes.buffer,
        getProxiedRemoteAddress: () => Buffer.alloc(0)
    };
    const app = {
        get: () => undefined,
        set: () => {},
        enabled: () => false,
        settings: {},
        _router: null,
        // what Router#_hot answers when nothing is set, since this stub has no settings at all
        _hot: () => ({ trustProxyFn: undefined, trustProxyProtocol: false, queryParserFn: undefined })
    };
    const request = new Request(req, res, app);
    request.res = { finished: false };
    return request.parsedIp;
}

test("an IPv4-mapped address reads as node writes it", () => {
    assert.strictEqual(ipOf(mapped(127, 0, 0, 1)), "::ffff:127.0.0.1");
    assert.strictEqual(ipOf(mapped(0, 0, 0, 0)), "::ffff:0.0.0.0");
    assert.strictEqual(ipOf(mapped(255, 255, 255, 255)), "::ffff:255.255.255.255");
    assert.strictEqual(ipOf(mapped(10, 1, 2, 3)), "::ffff:10.1.2.3");
    assert.strictEqual(ipOf(mapped(192, 168, 0, 255)), "::ffff:192.168.0.255");
});

test("everything else goes the long way and comes out in RFC 5952 form", () => {
    // the loopback, which is not mapped and must not be read as though it were
    assert.strictEqual(ipOf(groups(0, 0, 0, 0, 0, 0, 0, 1)), "::1");
    assert.strictEqual(ipOf(groups(0, 0, 0, 0, 0, 0, 0, 0)), "::");
    assert.strictEqual(ipOf(groups(0x2001, 0x0db8, 0, 0, 0, 0, 0, 1)), "2001:db8::1");
    assert.strictEqual(
        ipOf(groups(0x2001, 0x0db8, 0x85a3, 0, 0, 0x8a2e, 0x0370, 0x7334)),
        "2001:db8:85a3::8a2e:370:7334"
    );
    assert.strictEqual(ipOf(groups(0xfe80, 0, 0, 0, 0x0202, 0xb3ff, 0xfe1e, 0x8329)), "fe80::202:b3ff:fe1e:8329");
});

test("only the whole ::ffff:0:0/96 prefix takes the shortcut", () => {
    // 0xffff in the right place but a byte set before it, so it is an ordinary address that merely
    // looks like one. Reading it as mapped would have invented "::ffff:127.0.0.1" for it
    const impostor = bytesOf(0, 1);
    impostor[10] = 0xff;
    impostor[11] = 0xff;
    impostor[12] = 127;
    impostor[15] = 1;
    // the dotted tail belongs to the mapped form alone: with a group set before the zeros the
    // general formatter writes the last two groups as hex, which is what node writes too
    assert.strictEqual(ipOf(impostor), "1::ffff:7f00:1");

    // and the same at the byte just before the marker
    const alsoNot = new Uint8Array(16);
    alsoNot[9] = 1;
    alsoNot[10] = 0xff;
    alsoNot[11] = 0xff;
    alsoNot[12] = 127;
    alsoNot[15] = 1;
    assert.strictEqual(ipOf(alsoNot), "::1:ffff:7f00:1");
});

test("the window that reads the address up front closes and stays closed", async () => {
    const express = require("../../src/index.js");
    const app = express();
    // reads req.ip while the response is still open, which is the case that needs nothing read
    // ahead of time: an app that asks after the response is what flips needsIpAfterResponse
    app.get("/", (req, res) => res.send(String(req.ip)));
    const port = await new Promise((resolve) => app.listen(0, () => resolve(app.address().port)));
    try {
        for (let i = 0; i < 120; i++) {
            // dialled by address, not by name: "localhost" resolves to ::1 here and the loopback
            // this checks is the mapped IPv4 one
            const res = await fetch(`http://127.0.0.1:${port}/`);
            assert.equal(await res.text(), "::ffff:127.0.0.1");
        }
        // saturated rather than wrapped: the counter this replaced went round at 100000 and let a
        // hundred requests pay again for a discovery made long before
        assert.equal(app._ipProbes, 100);
        assert.equal(app.needsIpAfterResponse, false);
    } finally {
        app.close();
    }
});

test("four bytes are an IPv4 peer, and anything else is no address at all", () => {
    const four = new Uint8Array([203, 0, 113, 7]);
    // the app is not bound to an IPv4 address here, so node would report the mapped form
    assert.strictEqual(ipOf(four), "::ffff:203.0.113.7");
    assert.strictEqual(ipOf(new Uint8Array(0)), undefined);
});
