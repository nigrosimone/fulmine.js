"use strict";

// Windows caps a command line at roughly 32k characters. A normal commit stages a handful of files,
// but a sweeping one (a reformat, a rename) can stage hundreds, and passing every path to eslint
// goes straight past the limit and fails the hook. Above a threshold it is both safe and faster to
// let the tools walk the repo themselves, since they honour the same ignore files either way.
const MANY_FILES = 40;

const quote = (files) => files.map((file) => JSON.stringify(file)).join(" ");

module.exports = {
    "*.{js,cjs,mjs,ts}": (files) =>
        files.length > MANY_FILES
            ? ["eslint --fix .", "prettier --write ."]
            : [`eslint --fix ${quote(files)}`, `prettier --write ${quote(files)}`],
    "*.{json,md,yml,yaml}": (files) =>
        files.length > MANY_FILES ? ["prettier --write ."] : [`prettier --write ${quote(files)}`]
};
