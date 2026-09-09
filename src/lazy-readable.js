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

const { Readable } = require("stream");

// 128 KB of body buffered before uWS is asked to pause
const READABLE_OPTIONS = { highWaterMark: 128 * 1024 };

/**
 * A Readable that has not been built yet.
 *
 * Every request pays for the stream and almost none use it: a GET carries no body, and the bodies
 * that arrive are collected by uWS and handed to the parsers without touching the stream. Measured
 * on this machine, Readable's constructor is about 90ns of the 900ns a hello-world request costs.
 *
 * So the chain says Readable and the constructor does not run. `Request extends LazyReadable`, and
 * LazyReadable's prototype is Readable's, so `req instanceof Readable` stays true and every
 * Readable method is reachable. What is missing is `_readableState`, built on the first touch.
 *
 * The wrapping below is generated, not written out: every own member of Readable's prototype gets a
 * version that materialises first, so there is no list to keep in step. Missing one would be a
 * TypeError on `undefined._readableState`, not a slow path.
 */
class LazyReadableBase {}
Object.setPrototypeOf(LazyReadableBase.prototype, Readable.prototype);
Object.setPrototypeOf(LazyReadableBase, Readable);

// what the chain says at runtime, said again for the type checker, which cannot see a prototype
// being reassigned: everything a Readable offers is reachable from a Request, and is a Readable's
const LazyReadable = /** @type {typeof Readable} */ (/** @type {unknown} */ (LazyReadableBase));

/**
 * Builds the stream this object has been pretending to be. Idempotent: everything that can be
 * reached from outside goes through it, so it is called far more often than it does anything.
 *
 * EventEmitter's init keeps an _events that is already there, so listeners added before this
 * survive it.
 *
 * @param {any} stream the Request pretending to be one, before its state exists
 */
function materialise(stream) {
    if (stream._readableState === undefined) {
        Readable.call(stream, READABLE_OPTIONS);
    }
}

for (const member of [
    ...Object.getOwnPropertyNames(Readable.prototype),
    ...Object.getOwnPropertySymbols(Readable.prototype)
]) {
    // the constructor is not a door, and `readable` is handled below because a request writes it
    // and writing it must not build the very thing this is avoiding
    if (member === "constructor" || member === "readable") {
        continue;
    }
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Readable.prototype, member));
    if (typeof descriptor.value === "function") {
        const inner = descriptor.value;
        Object.defineProperty(LazyReadableBase.prototype, member, {
            ...descriptor,
            /** @this {any} @param {...any} args */
            value: function (...args) {
                materialise(this);
                return inner.apply(this, args);
            }
        });
    } else if (descriptor.get || descriptor.set) {
        const innerGet = descriptor.get;
        const innerSet = descriptor.set;
        Object.defineProperty(LazyReadableBase.prototype, member, {
            ...descriptor,
            get: innerGet
                ? /** @this {any} */ function () {
                      materialise(this);
                      return innerGet.call(this);
                  }
                : undefined,
            set: innerSet
                ? /** @this {any} @param {any} value */ function (value) {
                      materialise(this);
                      innerSet.call(this, value);
                  }
                : undefined
        });
    }
}

const nodeReadable = /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(Readable.prototype, "readable")
);

// `readable` on its own: a request sets it while it is being built, and node's setter is a no-op
// without the state anyway, so the flag is kept as a plain field until there is a stream to ask
Object.defineProperty(LazyReadableBase.prototype, "readable", {
    configurable: true,
    enumerable: false,
    /** @this {any} */
    get: function () {
        return this._readableState === undefined
            ? this._readableFlag === true
            : /** @type {any} */ (nodeReadable.get).call(this);
    },
    /** @this {any} @param {any} value */
    set: function (value) {
        if (this._readableState === undefined) {
            this._readableFlag = !!value;
            return;
        }
        /** @type {any} */ (nodeReadable.set).call(this, value);
    }
});

module.exports = { LazyReadable, READABLE_OPTIONS };
