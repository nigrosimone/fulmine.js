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
    /** Every field declared up front, one hidden class for every router's copy. */
    constructor() {
        this.epoch = 0;
        this.xPoweredBy = false;
        /** @type {((body: string|Buffer|import("fs").Stats, encoding?: BufferEncoding) => string)|undefined} */
        this.etagFn = undefined;
        // null means every method, which is express's behaviour and the default
        /** @type {Set<string>|null} */
        this.etagMethods = null;
        /** @type {((query: string|null) => Record<string, any>)|undefined} */
        this.queryParserFn = undefined;
        /** @type {import("./utils.js").TrustFn|undefined} */
        this.trustProxyFn = undefined;
        this.trustProxyProtocol = false;
        /** @type {boolean|undefined} */
        this.jsonEscape = undefined;
        /** @type {any} the "json replacer" setting, as stringify takes it */
        this.jsonReplacer = undefined;
        /** @type {string|number|undefined} */
        this.jsonSpaces = undefined;
    }
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
