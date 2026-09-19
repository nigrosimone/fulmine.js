/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

This file is derived from Ultimate Express and has been modified.

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

const { settingsEpoch } = require("./utils.js");

// The settings the hot paths read, resolved to plain fields: each read was a variadic get() whose
// rest array escapes into createRoute, plus a dictionary miss per mount level for the json keys.
// One shape for every router, stale when the epoch moves.
class HotSettings {
    /** The settings epoch these fields were resolved at, see _hot(). @type {number} */
    epoch = 0;

    /** @type {boolean} */
    xPoweredBy = false;

    /** @type {((body: string|Buffer|import("fs").Stats, encoding?: BufferEncoding) => string)|undefined} */
    etagFn = undefined;

    /** null means every method, which is express's behaviour and the default. @type {Set<string>|null} */
    etagMethods = null;

    /** @type {((query: string|null) => Record<string, any>)|undefined} */
    queryParserFn = undefined;

    /** @type {import("./utils.js").TrustFn|undefined} */
    trustProxyFn = undefined;

    /** @type {boolean} */
    trustProxyProtocol = false;

    /** @type {boolean|undefined} */
    jsonEscape = undefined;

    /** The "json replacer" setting, as stringify takes it. @type {any} */
    jsonReplacer = undefined;

    /** @type {string|number|undefined} */
    jsonSpaces = undefined;
}

/**
 * What app.settings is wrapped in, so a write that never went through set() still bumps the epoch.
 * Only writes are trapped, a read is the plain operation on the object.
 *
 * defineProperty is here for the trust proxy default marker, which set() writes that way.
 */
const settingsWriteTraps = {
    /**
     * @param {Record<string|symbol, unknown>} target the settings object itself, whose keys are the application's
     * @param {string|symbol} key
     * @param {unknown} value whatever the application is setting
     */
    set(target, key, value) {
        target[key] = value;
        settingsEpoch.n++;
        return true;
    },
    /**
     * @param {Record<string|symbol, unknown>} target the settings object itself
     * @param {string|symbol} key
     */
    deleteProperty(target, key) {
        delete target[key];
        settingsEpoch.n++;
        return true;
    },
    /**
     * @param {Record<string|symbol, unknown>} target the settings object itself
     * @param {string|symbol} key
     * @param {PropertyDescriptor} descriptor
     */
    defineProperty(target, key, descriptor) {
        Object.defineProperty(target, key, descriptor);
        settingsEpoch.n++;
        return true;
    }
};

module.exports = { HotSettings, settingsWriteTraps };
