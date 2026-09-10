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

const { Writable } = require("stream");

/**
 * A Writable that has not built its state yet, the mirror of LazyReadable and for the same reason:
 * a response is a Writable because middleware expects one, and the ordinary one never uses it.
 * `send()` reaches `end()`, which is overridden here and goes straight to _finish, so the
 * WritableState was allocated for every response and read by nobody. Only res.write(), a pipe,
 * cork and the writableX getters need it.
 *
 * `Response extends LazyWritable`, whose prototype is Writable's, so `res instanceof Writable`
 * stays true. `_writableState` is built on the first touch. Measured at 45ns a response.
 *
 * As on the Readable side the wrapping is generated: every own member of Writable's prototype gets
 * a version that materialises first, so there is no list to keep in step.
 */
class LazyWritableBase {}
Object.setPrototypeOf(LazyWritableBase.prototype, Writable.prototype);
Object.setPrototypeOf(LazyWritableBase, Writable);

// what the chain says at runtime, said again for the type checker, which cannot see a prototype
// being reassigned
const LazyWritable = /** @type {typeof Writable} */ (/** @type {unknown} */ (LazyWritableBase));

/**
 * Builds the stream this object has been pretending to be. Idempotent: everything reachable from
 * outside goes through it, so it is called far more often than it does anything.
 *
 * EventEmitter's init keeps an _events that is already there, so both the shape the constructor
 * wrote and any listener added before this survive it.
 *
 * @param {any} stream the Response pretending to be one, before its state exists
 */
function materialiseWritable(stream) {
    if (stream._writableState === undefined) {
        Writable.call(stream);
    }
}

for (const member of [
    ...Object.getOwnPropertyNames(Writable.prototype),
    ...Object.getOwnPropertySymbols(Writable.prototype)
]) {
    if (member === "constructor") {
        continue;
    }
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Writable.prototype, member));
    if (typeof descriptor.value === "function") {
        const inner = descriptor.value;
        Object.defineProperty(LazyWritableBase.prototype, member, {
            ...descriptor,
            /** @this {import("stream").Writable} @param {...unknown} args */
            value: function (...args) {
                materialiseWritable(this);
                return inner.apply(this, args);
            }
        });
    } else if (descriptor.get || descriptor.set) {
        const innerGet = descriptor.get;
        const innerSet = descriptor.set;
        Object.defineProperty(LazyWritableBase.prototype, member, {
            ...descriptor,
            get: innerGet
                ? /** @this {import("stream").Writable} */ function () {
                      materialiseWritable(this);
                      return innerGet.call(this);
                  }
                : undefined,
            set: innerSet
                ? /** @this {import("stream").Writable} @param {unknown} value */ function (value) {
                      materialiseWritable(this);
                      innerSet.call(this, value);
                  }
                : undefined
        });
    }
}

module.exports = { LazyWritable };
