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

import { uWebSocketsTransport } from "@colyseus/uwebsockets-transport";

/**
 * Colyseus's uWebSockets.js transport, with Fulmine serving the express routes.
 *
 * ```ts
 * import { defineServer } from "@colyseus/core";
 * import { FulmineTransport } from "fulmine.js/colyseus";
 *
 * const server = defineServer({
 *     transport: new FulmineTransport(),
 *     rooms: { my_room: MyRoom },
 *     express: (app) => app.get("/hello", (req, res) => res.json({ hello: "world" }))
 * });
 * ```
 *
 * `@colyseus/uwebsockets-transport` is an optional peer dependency: only this entry point needs it.
 */
export declare class FulmineTransport extends uWebSocketsTransport {}
