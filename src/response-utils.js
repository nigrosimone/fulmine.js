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

const http = require("http");
const statuses = require("statuses");
const { EventEmitter } = require("events");

const outgoingMessage = new http.OutgoingMessage();
const symbols = Object.getOwnPropertySymbols(outgoingMessage);
// if a future node renames it, fall back to a private symbol rather than writing a property
// literally named "undefined", which is what indexing with undefined would do
const kOutHeaders = symbols.find((s) => s.toString() === "Symbol(kOutHeaders)") ?? Symbol("kOutHeaders");
// node's emitters tombstone a removed listener's slot instead of deleting it when this flag is set,
// which keeps _events in a stable shape. EventEmitter.init sets it and never runs for the lazily
// materialized response, so it is set by hand. A future rename degrades to the delete
const kShapeMode =
    Object.getOwnPropertySymbols(new EventEmitter()).find((s) => s.toString() === "Symbol(shapeMode)") ??
    Symbol("shapeMode");
// names setHeader has validated and lowercased, so the constant names middleware writes per
// request are one Map hit. Insert-only after validation, bounded; only setHeader may insert,
// the never-throwing readers keep their plain toLowerCase
const VALIDATED_HEADER_NAMES = new Map();
// The names and values that recur on every response, kept as Buffers for the uWS crossing: a Buffer
// is memcpy'd as it is, a string pays a UTF-8 scan and copy per call. A header that is not here
// crosses as the string it was. Names must stay lowercase, as writeHeaders receives them.
const HEADER_NAME_BUF = { __proto__: null };
const HEADER_VALUE_BUF = { __proto__: null };
for (const s of ["connection", "keep-alive", "content-type", "vary", "x-powered-by", "content-encoding"]) {
    HEADER_NAME_BUF[s] = Buffer.from(s);
}
for (const s of [
    "keep-alive",
    "timeout=10",
    "close",
    "Fulmine",
    "Accept-Encoding",
    "text/html; charset=utf-8",
    "text/plain; charset=utf-8",
    "application/json; charset=utf-8",
    "application/octet-stream",
    "gzip",
    "br",
    "deflate",
    "zstd",
    // res.set("Content-Type", x) stores false when the mime database knows nothing about x, the
    // way express does, and the lookup below turns that back into the bytes node writes for it
    "false"
]) {
    HEADER_VALUE_BUF[s] = Buffer.from(s);
}

// One status line per code, built on first use: the default path, with no custom reason phrase,
// paid a template string and a trim per request for a line that never changes. Bounded to real
// HTTP codes so a wild writeHead value cannot grow the array or flip it into dictionary mode.
const STATUS_LINES = [];
/**
 * @param {number} code
 * @param {string|undefined} text an explicit reason phrase, which bypasses the cache
 * @returns {string} the uWS status line, e.g. "200 OK"
 */
function statusLine(code, text) {
    if (text === undefined && Number.isInteger(code) && code >= 100 && code <= 999) {
        return STATUS_LINES[code] ?? (STATUS_LINES[code] = code + " " + (statuses.message[code] ?? "unknown"));
    }
    return `${code} ${text ?? statuses.message[code] ?? "unknown"}`.trim();
}

module.exports = {
    kOutHeaders,
    kShapeMode,
    VALIDATED_HEADER_NAMES,
    HEADER_NAME_BUF,
    HEADER_VALUE_BUF,
    statusLine
};
