import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";
import { fileURLToPath } from "node:url";

const repo = "https://github.com/nigrosimone/fulmine.js";

// The pages are the repository's own docs/, read in place, so there is one copy of everything.
// A link there that climbs out of docs/ (../examples/x.js, ../README.md) is a file on GitHub
// and not a page here, so it is pointed at the repository instead.
export default defineConfig({
    srcDir: "../docs",
    title: "Fulmine.js",
    description: "Drop-in Express 5 replacement on uWebSockets.js, up to 20x faster. Your middleware keeps working.",
    lang: "en",
    cleanUrls: true,
    lastUpdated: true,
    sitemap: { hostname: "https://fulmine.sndesign.it" },
    // llms.txt (the index) and llms-full.txt (every page in one file), for the models that read docs
    vite: {
        plugins: [llmstxt({ domain: "https://fulmine.sndesign.it" })],
        // the pages live outside this directory, so vue has to be found from here and not from docs/
        resolve: { alias: { vue: fileURLToPath(new URL("../node_modules/vue", import.meta.url)) } }
    },
    head: [
        ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
        ["meta", { name: "theme-color", content: "#ff6b2c" }],
        ["meta", { property: "og:type", content: "website" }],
        ["meta", { property: "og:title", content: "Fulmine.js: the drop-in Express 5 replacement, up to 20x faster" }],
        ["meta", { property: "og:site_name", content: "Fulmine.js" }],
        ["meta", { property: "og:url", content: "https://fulmine.sndesign.it/" }]
    ],
    markdown: {
        // the default github themes paint comments too light for the contrast audit
        theme: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
        config(md) {
            const render =
                md.renderer.rules.link_open ??
                ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
            md.renderer.rules.link_open = (tokens, i, options, env, self) => {
                const href = tokens[i].attrGet("href");
                if (href && href.startsWith("../")) {
                    const target = href.slice(3);
                    tokens[i].attrSet(
                        "href",
                        `${repo}/${target.endsWith("/") || !target.includes(".") ? "tree" : "blob"}/main/${target}`
                    );
                }
                return render(tokens, i, options, env, self);
            };
        }
    },
    themeConfig: {
        logo: { src: "/logo-mark.svg", alt: "", width: 24, height: 24 },
        nav: [
            { text: "Guide", link: "/migrating" },
            { text: "Performance", link: "/performance" },
            { text: "Compare", link: "/compare" },
            { text: "npm", link: "https://www.npmjs.com/package/fulmine.js" }
        ],
        sidebar: [
            {
                text: "Start here",
                items: [
                    { text: "Why Fulmine", link: "/why" },
                    { text: "Migrating from Express", link: "/migrating" },
                    { text: "Compared with the others", link: "/compare" }
                ]
            },
            {
                text: "Running it",
                items: [
                    { text: "Deploying", link: "/deployment" },
                    { text: "Performance", link: "/performance" },
                    { text: "WebSockets", link: "/websockets" }
                ]
            },
            {
                text: "Reference",
                items: [
                    { text: "Differences from Express", link: "/differences" },
                    { text: "Compatibility", link: "/compatibility" },
                    { text: "Examples", link: `${repo}/tree/main/examples` },
                    { text: "Changelog", link: `${repo}/blob/main/CHANGELOG.md` }
                ]
            }
        ],
        socialLinks: [
            { icon: "github", link: repo },
            { icon: "npm", link: "https://www.npmjs.com/package/fulmine.js" }
        ],
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
        search: { provider: "local" },
        footer: {
            message:
                "Apache-2.0. A derivative work of Ultimate Express by @dimdenGD. Not affiliated with the Express.js project.",
            copyright: "Nigro Simone"
        }
    }
});
