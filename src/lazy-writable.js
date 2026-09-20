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
 * The mirror of LazyReadable: a response is a Writable because middleware expects one, but send()
 * goes straight to _finish and only res.write(), a pipe, cork and the writableX getters need the
 * state, so it is built on the first touch. Measured at 45ns a response. Same generated wrapping.
 */
class LazyWritableBase {}
Object.setPrototypeOf(LazyWritableBase.prototype, Writable.prototype);
Object.setPrototypeOf(LazyWritableBase, Writable);

// what the chain says at runtime, said again for the type checker, which cannot see a prototype
// being reassigned
const LazyWritable = /** @type {typeof Writable} */ (/** @type {unknown} */ (LazyWritableBase));

/**
 * Builds the stream this object has been pretending to be, idempotent. EventEmitter's init keeps
 * an _events already there, so the constructor's shape and earlier listeners survive.
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
        // the original's accessor pair, each half wrapped where there is one
        const wrapped = { ...descriptor };
        if (innerGet) {
            wrapped.get = /** @this {import("stream").Writable} */ function () {
                materialiseWritable(this);
                return innerGet.call(this);
            };
        }
        if (innerSet) {
            wrapped.set = /** @this {import("stream").Writable} @param {unknown} value */ function (value) {
                materialiseWritable(this);
                innerSet.call(this, value);
            };
        }
        Object.defineProperty(LazyWritableBase.prototype, member, wrapped);
    }
}

module.exports = { LazyWritable };
