/*
Copyright 2024 dimden.dev
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

const fs = require("fs");
const { parentPort } = require("worker_threads");

// this file is only ever loaded as a worker, where parentPort is always present. Reading it in the
// main thread would give null, so say so once here rather than at each use
if (!parentPort) {
    throw new Error("worker.js must be loaded as a worker thread");
}
const port = parentPort;

port.on("message", (message) => {
    if (message.type === "readFile") {
        try {
            const data = fs.readFileSync(message.path);
            const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            port.postMessage({ key: message.key, data: ab }, [ab]);
        } catch (err) {
            port.postMessage({ key: message.key, err: String(err) });
        }
    }
});
