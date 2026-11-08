// The Ts.ED application the case serves on both platforms. The platform is chosen by the case, so
// this file does not import one.

import "@tsed/ajv";

import { fileURLToPath } from "node:url";

import { Configuration } from "@tsed/di";

import { ItemsController } from "./controllers/ItemsController.js";

@Configuration({
    mount: { "/rest": [ItemsController] },
    statics: { "/": [{ root: fileURLToPath(new URL("../public", import.meta.url)) }] },
    middlewares: ["json-parser", "text-parser", { use: "urlencoded-parser", options: { extended: true } }],
    logger: { level: "off" },
    disableComponentsScan: true
})
export class Server {}
