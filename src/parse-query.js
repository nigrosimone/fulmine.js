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

/*
The parser from fast-querystring 1.1.x (https://github.com/anonrig/fast-querystring), Copyright
(c) 2022 Yagiz Nizipli, MIT, whose permission notice is reproduced in full in NOTICE at the root
of this package. Vendored for one change: the result is a bare
Object.create(null) instead of the library's Empty-constructor trick. The trick is faster to
construct but node inspects it as "Empty <[Object: null prototype] {}>", where Express shows
"[Object: null prototype]", and matching that used to cost an Object.assign copy of every parse
on every query-carrying request. The copy was worth more than the trick.
*/

const fastDecode = require("fast-decode-uri-component");

const plusRegex = /\+/g;

/**
 * node's querystring.parse semantics on a null-prototype result: repeated keys accumulate into
 * arrays, '+' is a space, percent sequences decode when present and stay literal when broken.
 *
 * `capture` collects the decoded pairs flat, key then value, so a caller can replay the stores
 * without scanning again; a repeated key marks it invalid instead. See `get query`.
 *
 * `separatorLimit` refuses a body with that many "&" separators the way body-parser's
 * parameterCount does, but inside this scan instead of a scan of its own: the overflow flag on
 * the function is set, the partial result is to be discarded, and the caller answers 413.
 *
 * @param {string} input
 * @param {string[] & {invalid?: boolean}} [capture]
 * @param {number} [separatorLimit]
 * @returns {Record<string, string | string[]>}
 */
function parseQuery(input, capture, separatorLimit) {
    const result = Object.create(null);
    if (separatorLimit !== undefined) {
        parseQuery.overflow = false;
    }

    if (typeof input !== "string") {
        return result;
    }

    const inputLength = input.length;
    let separators = 0;
    let key;
    let value = "";
    let startingIndex = -1;
    let equalityIndex = -1;
    let shouldDecodeKey = false;
    let shouldDecodeValue = false;
    let keyHasPlus = false;
    let valueHasPlus = false;
    let hasBothKeyValuePair;
    let c;

    // a boundary of input.length + 1, so the last pair is handled inside the loop
    for (let i = 0; i < inputLength + 1; i++) {
        c = i !== inputLength ? input.charCodeAt(i) : 38;

        // '&' or the end of the input closes the current pair
        if (c === 38) {
            // real separators only, not the synthetic closing one, counted exactly as
            // parameterCount counts them
            if (i !== inputLength && separatorLimit !== undefined && ++separators === separatorLimit) {
                parseQuery.overflow = true;
                return result;
            }
            hasBothKeyValuePair = equalityIndex > startingIndex;

            // the equality index doubles as the end of the key when there was no '='
            if (!hasBothKeyValuePair) {
                equalityIndex = i;
            }

            key = input.slice(startingIndex + 1, equalityIndex);

            // only a pair with at least an '=' or a non-empty key lands in the result
            if (hasBothKeyValuePair || key.length > 0) {
                if (keyHasPlus) {
                    key = key.replace(plusRegex, " ");
                }
                if (shouldDecodeKey) {
                    key = fastDecode(key) || key;
                }
                if (hasBothKeyValuePair) {
                    value = input.slice(equalityIndex + 1, i);
                    if (valueHasPlus) {
                        value = value.replace(plusRegex, " ");
                    }
                    if (shouldDecodeValue) {
                        value = fastDecode(value) || value;
                    }
                }

                const currentValue = result[key];
                if (currentValue === undefined) {
                    result[key] = value;
                    if (capture !== undefined) {
                        capture.push(key, value);
                    }
                } else {
                    if (capture !== undefined) {
                        capture.invalid = true;
                    }
                    // value.pop is cheaper than Array.isArray here, as upstream measured
                    if (currentValue.pop) {
                        currentValue.push(value);
                    } else {
                        result[key] = [currentValue, value];
                    }
                }
            }

            value = "";
            startingIndex = i;
            equalityIndex = i;
            shouldDecodeKey = false;
            shouldDecodeValue = false;
            keyHasPlus = false;
            valueHasPlus = false;
        } else if (c === 61) {
            if (equalityIndex <= startingIndex) {
                equalityIndex = i;
            } else {
                // a second '=' belongs to the value and needs decoding
                shouldDecodeValue = true;
            }
        } else if (c === 43) {
            if (equalityIndex > startingIndex) {
                valueHasPlus = true;
            } else {
                keyHasPlus = true;
            }
        } else if (c === 37) {
            if (equalityIndex > startingIndex) {
                shouldDecodeValue = true;
            } else {
                shouldDecodeKey = true;
            }
        }
    }

    return result;
}

// whether the last limited call hit its separator limit, see the parameter's doc
parseQuery.overflow = false;

module.exports = parseQuery;
