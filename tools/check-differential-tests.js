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

// Refuses to commit a differential test that is pointing at the local source.
//
// The harness runs each of these files twice by rewriting its first import: once as written,
// against the real Express, and once with the import swapped for src/index.js. It puts the file
// back afterwards, but the file is on disk in the swapped state while the run is going, and a
// commit made in that window records it. What lands then is a test that compares fulmine against
// fulmine and passes whatever it does. That happened once, hence this.
//
// Run by lint-staged over the staged test files.

"use strict";

const fs = require("fs");

const SWAPPED = 'require("../../../src/index.js")';

const bad = process.argv.slice(2).filter((file) => fs.readFileSync(file, "utf8").includes(SWAPPED));

if (bad.length > 0) {
    console.error(
        `These tests import the local source instead of express, which is how the harness leaves them
while it is running. Wait for the suite to finish, or restore them with git checkout:

` + bad.map((file) => "    " + file).join("\n")
    );
    process.exit(1);
}
