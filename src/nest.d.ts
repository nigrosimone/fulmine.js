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

import { ExpressAdapter } from "@nestjs/platform-express";

/**
 * Nest's Express adapter, listening on uWebSockets.js instead of on node.
 *
 * ```ts
 * import { NestFactory } from "@nestjs/core";
 * import { FulmineExpressAdapter } from "fulmine.js/nest";
 *
 * const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
 * await app.listen(3000);
 * ```
 *
 * `@nestjs/platform-express` is an optional peer dependency: this entry point is the only thing
 * that needs it, and nothing loads it unless you import this.
 */
export declare class FulmineExpressAdapter extends ExpressAdapter {
    /**
     * @param instance an application from `fulmine()`; one is created when omitted. Pass your own
     * when it needs options, TLS being the usual reason: `fulmine({ uwsOptions })`.
     */
    constructor(instance?: any);
}
