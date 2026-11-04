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

// the global Buffer is a getter, a call on every read
const { Buffer } = require("buffer");
const { NullObject } = require("./utils.js");

/**
 * @typedef {object} MultipartFile
 * @property {string} fieldname
 * @property {string} originalname
 * @property {string} encoding
 * @property {string} mimetype
 * @property {number} size
 * @property {Buffer} buffer a view on the body
 */

/**
 * @typedef {object} PartHeaders
 * @property {string} [name]
 * @property {string} [filename]
 * @property {string} [mimetype]
 * @property {string} [encoding]
 */

const CR = 13;
const LF = 10;
const DASH = 45;
const SPACE = 32;
const TAB = 9;

// what delimiterEnd answers on the closing delimiter, and on bytes that are not a delimiter
const CLOSED = -2;
const NOT_A_DELIMITER = -1;

const BOUNDARY = /;\s*boundary=(?:"([^"]+)"|([^\s;"]+))/i;
const HEADERS_END = Buffer.from("\r\n\r\n", "latin1");

/**
 * What follows a delimiter: `--` closes the body, padding and a CRLF open a part, anything else
 * means it was only the start of a line of data.
 *
 * @param {Buffer} body
 * @param {number} at the first byte after the delimiter
 * @returns {number} the first byte of the part, CLOSED or NOT_A_DELIMITER
 */
function delimiterEnd(body, at) {
    if (body[at] === DASH && body[at + 1] === DASH) {
        return CLOSED;
    }
    let next = at;
    while (body[next] === SPACE || body[next] === TAB) {
        next++;
    }
    return body[next] === CR && body[next + 1] === LF ? next + 2 : NOT_A_DELIMITER;
}

/**
 * @param {Buffer} body
 * @param {Buffer} delimiter
 * @param {number} from
 * @returns {number} where the next real delimiter starts, -1 if there is none
 */
function findDelimiter(body, delimiter, from) {
    let at = from;
    for (;;) {
        at = body.indexOf(delimiter, at);
        if (at === -1 || delimiterEnd(body, at + delimiter.length) !== NOT_A_DELIMITER) {
            return at;
        }
        at += delimiter.length;
    }
}

/**
 * A path in a filename is the client's, and a `../` in it must not reach whoever writes the file.
 *
 * @param {string} filename
 * @returns {string} the last segment
 */
function baseName(filename) {
    const base = filename.slice(Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1);
    return base === "." || base === ".." ? "" : base;
}

/**
 * @param {string} value a filename*, as RFC 5987 writes it
 * @returns {string|undefined} undefined on a charset other than utf-8 or a bad escape
 */
function decodeExtended(value) {
    const first = value.indexOf("'");
    const second = value.indexOf("'", first + 1);
    if (first === -1 || second === -1 || value.slice(0, first).toLowerCase() !== "utf-8") {
        return undefined;
    }
    try {
        return decodeURIComponent(value.slice(second + 1));
    } catch {
        return undefined;
    }
}

/**
 * @param {string} value the header value
 * @param {PartHeaders} part where name and filename go
 */
function readDisposition(value, part) {
    const semicolon = value.indexOf(";");
    const kind = value.slice(0, semicolon === -1 ? value.length : semicolon);
    if (kind.trim().toLowerCase() !== "form-data") {
        return;
    }
    let extended;
    let at = semicolon + 1;
    while (at > 0 && at < value.length) {
        const equals = value.indexOf("=", at);
        if (equals === -1) {
            break;
        }
        const key = value.slice(at, equals).trim().toLowerCase();
        let start = equals + 1;
        while (value[start] === " " || value[start] === "\t") {
            start++;
        }
        let text = "";
        let end;
        if (value[start] === '"') {
            // only \" and \\ are escapes: a browser leaves C:\dir\file.txt as it is
            for (end = start + 1; end < value.length && value[end] !== '"'; end++) {
                if (value[end] === "\\" && (value[end + 1] === '"' || value[end + 1] === "\\")) {
                    end++;
                }
                text += value[end];
            }
        } else {
            end = value.indexOf(";", start);
            text = value.slice(start, end === -1 ? value.length : end).trim();
        }
        if (key === "name") {
            part.name = text;
        } else if (key === "filename") {
            part.filename = text;
        } else if (key === "filename*") {
            extended = decodeExtended(text);
        }
        if (end === -1) {
            break;
        }
        at = value.indexOf(";", end) + 1;
    }
    if (extended !== undefined) {
        part.filename = extended;
    }
}

/**
 * @param {string} block the part's headers, without the blank line that ends them
 * @returns {PartHeaders}
 */
function readPartHeaders(block) {
    /** @type {PartHeaders} */
    const part = {};
    let at = 0;
    while (at < block.length) {
        const eol = block.indexOf("\r\n", at);
        const end = eol === -1 ? block.length : eol;
        const colon = block.indexOf(":", at);
        if (colon !== -1 && colon < end) {
            const name = block.slice(at, colon).trim().toLowerCase();
            if (name === "content-disposition") {
                readDisposition(block.slice(colon + 1, end), part);
            } else if (name === "content-type") {
                part.mimetype = block.slice(colon + 1, end).trim();
            } else if (name === "content-transfer-encoding") {
                part.encoding = block.slice(colon + 1, end).trim();
            }
        }
        at = end + 2;
    }
    return part;
}

/**
 * One pass over the collected body. A file is a view on it, nothing is copied.
 *
 * @param {Buffer} body
 * @param {string} contentType the request's, for the boundary
 * @returns {{fields: Record<string, string|string[]>, files: MultipartFile[]}|null} null when the
 *   body is not a complete multipart body, a missing closing delimiter included
 */
function parseMultipart(body, contentType) {
    const match = BOUNDARY.exec(contentType);
    if (match === null) {
        return null;
    }
    const delimiter = Buffer.from(`\r\n--${match[1] ?? match[2]}`, "latin1");
    const size = delimiter.length;

    // the first delimiter has no CRLF of its own, unless a preamble comes before it
    const opens = body.length >= size - 2 && body.compare(delimiter, 2, size, 0, size - 2) === 0;
    let next = opens ? delimiterEnd(body, size - 2) : NOT_A_DELIMITER;
    if (next === NOT_A_DELIMITER) {
        const first = findDelimiter(body, delimiter, 0);
        if (first === -1) {
            return null;
        }
        next = delimiterEnd(body, first + size);
    }

    /** @type {Record<string, string|string[]>} */
    const fields = new NullObject();
    /** @type {MultipartFile[]} */
    const files = [];
    while (next !== CLOSED) {
        // a part with no headers starts on the blank line
        const headersEnd = body[next] === CR && body[next + 1] === LF ? next : body.indexOf(HEADERS_END, next);
        if (headersEnd === -1) {
            return null;
        }
        const start = headersEnd === next ? next + 2 : headersEnd + 4;
        // from the blank line's own CRLF, which is the delimiter's on an empty part
        const stop = findDelimiter(body, delimiter, start - 2);
        if (stop === -1) {
            return null;
        }
        const end = Math.max(start, stop);
        const part = readPartHeaders(body.toString("utf8", next, headersEnd));
        if (part.name !== undefined) {
            if (part.filename === undefined) {
                const value = body.toString("utf8", start, end);
                const had = fields[part.name];
                if (had === undefined) {
                    fields[part.name] = value;
                } else if (typeof had === "string") {
                    fields[part.name] = [had, value];
                } else {
                    had.push(value);
                }
            } else {
                // an empty filename is a file input left empty
                const originalname = baseName(part.filename);
                if (originalname !== "") {
                    const buffer = body.subarray(start, end);
                    files.push({
                        fieldname: part.name,
                        originalname,
                        encoding: part.encoding ?? "7bit",
                        mimetype: part.mimetype ?? "application/octet-stream",
                        size: buffer.length,
                        buffer
                    });
                }
            }
        }
        next = delimiterEnd(body, stop + size);
    }
    return { fields, files };
}

module.exports = parseMultipart;
