import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// middleware mode, whose dist/server/entry.mjs exports a handler an express application can mount.
// standalone mode would start its own server instead, which is not what is being tested
export default defineConfig({
    output: "server",
    adapter: node({ mode: "middleware" }),
    devToolbar: { enabled: false },
    // The built entry imports `cookie` and resolves it from where the bundle sits, which here is a
    // directory under a shared node_modules holding express's copy rather than astro's. Bundling it
    // in takes the resolution out of the equation; a real astro project has its own node_modules
    // and never meets this.
    vite: { ssr: { noExternal: ["cookie"] } }
});
