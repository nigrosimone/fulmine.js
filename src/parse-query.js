"use strict";

/*
The parser from fast-querystring 1.1.x (MIT, Copyright (c) Yagiz Nizipli,
https://github.com/anonrig/fast-querystring), vendored for one change: the result is a bare
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
 * @param {string} input
 * @returns {Record<string, string | string[]>}
 */
function parseQuery(input) {
    const result = Object.create(null);

    if (typeof input !== "string") {
        return result;
    }

    const inputLength = input.length;
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
                } else {
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

module.exports = parseQuery;
