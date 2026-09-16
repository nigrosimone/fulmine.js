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

// µWebSockets.js, loaded the first time something needs it rather than when this package is
// required. An application that is built and never listens never loads the binary. Angular's
// build imports server.ts in a worker thread to extract the routes and serves it through node's
// http, and on Windows the binary crashes the process when a thread that loaded it exits
// (uNetworking/uWebSockets.js#668), so the build only works if nothing in that thread loads it.

/** @type {any} */
let uWS;

/**
 * The µWS module. H3App, DeclarativeResponse and _cfg exist at runtime but are missing from the
 * .d.ts the package ships, so it is handed back loosely typed.
 *
 * @returns {any}
 */
function loadUWS() {
    if (uWS === undefined) {
        uWS = /** @type {any} */ (require("uWebSockets.js"));
        try {
            // disable Uwebsockets header
            uWS._cfg("999999990007");
        } catch (error) {
            // older uWS builds do not expose _cfg; there is nothing to fall back to
        }
    }
    return uWS;
}

module.exports = { loadUWS };
