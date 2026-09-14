/*
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Not a test file: the unit runner globs *.test.js, and this is what two of them share.

const http = require("node:http");

/** @type {string|undefined} */
let cached;

/**
 * What node reports as the peer of a v4 loopback client of a listener bound the way these tests
 * bind, with no host. A host with IPv6 listens dual stack and reports "::ffff:127.0.0.1", one
 * without it listens on IPv4 alone and reports "127.0.0.1", and both are correct answers for
 * req.ip to give: node is the thing being matched, so it is asked rather than assumed. Asked once,
 * since nothing about a machine's loopback changes between two tests.
 *
 * @returns {Promise<string>} the address, as node writes it
 */
async function loopbackPeer() {
    if (cached !== undefined) {
        return cached;
    }
    const server = http.createServer((req, res) => res.end(req.socket.remoteAddress));
    await new Promise((resolve) => server.listen(0, () => resolve(undefined)));
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    const answer = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    cached = answer;
    return answer;
}

module.exports = { loopbackPeer };
