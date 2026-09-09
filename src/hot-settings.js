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

// The settings the request and response hot paths read, resolved to plain fields: each read was a
// variadic get() whose rest array escapes into createRoute, plus a dictionary miss per mount level
// for the json keys, which have no default. One shape for every router, stale when the epoch moves.
class HotSettings {
    /** Every field declared up front, one hidden class for every router's copy. */
    constructor() {
        this.epoch = 0;
        this.xPoweredBy = false;
        this.etagFn = undefined;
        // null means every method, which is express's behaviour and the default
        this.etagMethods = null;
        this.queryParserFn = undefined;
        this.trustProxyFn = undefined;
        this.trustProxyProtocol = false;
        this.jsonEscape = undefined;
        this.jsonReplacer = undefined;
        this.jsonSpaces = undefined;
    }
}

/**
 * What app.settings is wrapped in, so a write that never went through set() still tells the hot
 * copies they are out of date. Only writes are trapped: a missing trap is the plain operation on
 * the object itself, so reads through here behave exactly as they did.
 *
 * defineProperty is here for the trust proxy default marker, which set() writes that way, and for
 * anything else reaching for Object.defineProperty rather than an assignment.
 */
const settingsWriteTraps = {
    /**
     * @param {any} target
     * @param {string|symbol} key
     * @param {any} value
     */
    set(target, key, value) {
        target[key] = value;
        settingsEpoch.n++;
        return true;
    },
    /**
     * @param {any} target
     * @param {string|symbol} key
     */
    deleteProperty(target, key) {
        delete target[key];
        settingsEpoch.n++;
        return true;
    },
    /**
     * @param {any} target
     * @param {string|symbol} key
     * @param {any} descriptor
     */
    defineProperty(target, key, descriptor) {
        Object.defineProperty(target, key, descriptor);
        settingsEpoch.n++;
        return true;
    }
};

module.exports = { HotSettings, settingsWriteTraps };
