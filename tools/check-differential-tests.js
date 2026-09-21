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

// Refuses to commit a differential test pointing at the local source: tests/singular.js swaps the
// express import for src/index.js while it runs, and a commit in that window records a test that
// compares fulmine against fulmine. Happened once, when the suite itself still rewrote the file.
// Run by lint-staged.

"use strict";

const fs = require("fs");

const SWAPPED = 'require("../../../src/index.js")';

const bad = process.argv.slice(2).filter((file) => fs.readFileSync(file, "utf8").includes(SWAPPED));

if (bad.length > 0) {
    console.error(
        `These tests import the local source instead of express, which is how tests/singular.js leaves
them while it is running. Wait for it to finish, or restore them with git checkout:

` + bad.map((file) => "    " + file).join("\n")
    );
    process.exit(1);
}
