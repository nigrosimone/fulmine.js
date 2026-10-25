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

"use strict";

/**
 * A dependency loaded on its first use. mime-db, qs, fast-zlib and acorn are about a megabyte of
 * heap an app that never asks for them still carried, and V8 starts its full collections on the
 * old generation size: a small heap stays out of them.
 *
 * @param {string} id a package name, resolved as a require in src/ would
 * @returns {(() => any) & {release: () => void}} the getter; release() drops the module, the next
 *   call loads it again
 */
function lazyRequire(id) {
    /** @type {any} */
    let loaded;
    const get = () => (loaded ??= require(id));
    return Object.assign(get, {
        release() {
            loaded = undefined;
            const path = require.resolve(id);
            const cached = require.cache[path];
            delete require.cache[path];
            // this module lists what it required in children, which kept the source alive
            const { children } = /** @type {NodeJS.Module} */ (/** @type {unknown} */ (module));
            const at = cached === undefined ? -1 : children.indexOf(cached);
            if (at !== -1) {
                children.splice(at, 1);
            }
        }
    });
}

// the handler analysis needs acorn while routes are registered, listen() releases it
const acorn = /** @type {(() => typeof import("acorn")) & {release: () => void}} */ (lazyRequire("acorn"));

module.exports = { lazyRequire, acorn };
