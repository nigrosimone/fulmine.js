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

// npx fulmine.js create <dir> [--ts]
//
// A new project, for whoever has no Express application to migrate. `migrate` and `override` start
// from somebody's code; this starts from nothing and writes the few files a first run needs: a
// server, a package.json, and the Dockerfile that works, since the base image is the one thing a
// Dockerfile written for Express gets wrong here. Nothing is installed, that is the user's call.

"use strict";

const fs = require("fs");
const path = require("path");

const SELF = "fulmine.js";

/** The major this package tracks, which is the range a new project should ask for. */
const MAJOR = require("../package.json").version.split(".")[0];

/**
 * The node major the Dockerfile names: the one running this when it has a µWS binary, which is the
 * even lines, and the newest supported one otherwise.
 *
 * @returns {number}
 */
function nodeMajor() {
    const running = Number(process.versions.node.split(".")[0]);
    return running >= 22 && running % 2 === 0 ? running : 26;
}

/**
 * The server, in the flavour asked for. The same three routes either way: a page, a JSON answer
 * with a parameter, and a body read by the built-in parser.
 *
 * @param {boolean} ts
 * @returns {string}
 */
function serverSource(ts) {
    const types = ts ? 'import type { Request, Response } from "fulmine.js";\n' : "";
    const params = ts ? "(req: Request, res: Response)" : "(req, res)";
    return `import express from "${SELF}";
${types}
const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(express.static("public"));

app.get("/api/hello", ${params} => {
    res.json({ hello: "world" });
});

app.get("/api/items/:id", ${params} => {
    res.json({ id: req.params.id });
});

app.post("/api/items", ${params} => {
    res.status(201).json(req.body);
});

app.listen(port, () => {
    console.log(\`listening on http://localhost:\${port}\`);
});
`;
}

/**
 * @param {string} name the package name, from the directory
 * @param {boolean} ts
 * @returns {string}
 */
function packageSource(name, ts) {
    const pkg = {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: ts
            ? {
                  build: "tsc",
                  start: "node dist/server.js",
                  dev: "node --watch --experimental-strip-types src/server.ts"
              }
            : { start: "node server.js", dev: "node --watch server.js" },
        dependencies: { [SELF]: `^${MAJOR}` },
        ...(ts ? { devDependencies: { "@types/node": `^${nodeMajor()}`, typescript: "^5" } } : {}),
        engines: { node: ">=22" }
    };
    return JSON.stringify(pkg, null, 4) + "\n";
}

const TSCONFIG = `{
    "compilerOptions": {
        "target": "es2022",
        "module": "nodenext",
        "outDir": "dist",
        "rootDir": "src",
        "strict": true,
        "verbatimModuleSyntax": true,
        "skipLibCheck": true,
        "types": ["node"]
    },
    "include": ["src"]
}
`;

/**
 * Install with the full image, which has git for the µWS fetch, run with the slim one. trixie or
 * newer on both, since bookworm's glibc is too old for the binary and Alpine has no build at all.
 *
 * @param {boolean} ts
 * @returns {string}
 */
function dockerfileSource(ts) {
    const major = nodeMajor();
    const build = ts
        ? `COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev`
        : `COPY package*.json ./
RUN npm ci --omit=dev`;
    const run = ts
        ? `COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 3000
CMD ["node", "dist/server.js"]`
        : `COPY --from=build /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]`;
    return `FROM node:${major}-trixie AS build
WORKDIR /app
${build}

FROM node:${major}-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
${run}
`;
}

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>fulmine.js</title>
<p>Served by <code>express.static()</code>. The API answers on <a href="/api/hello">/api/hello</a>.</p>
`;

/**
 * The files a new project is made of, by path.
 *
 * @param {string} name
 * @param {boolean} ts
 * @returns {Record<string, string>}
 */
function projectFiles(name, ts) {
    return {
        "package.json": packageSource(name, ts),
        [ts ? "src/server.ts" : "server.js"]: serverSource(ts),
        ...(ts ? { "tsconfig.json": TSCONFIG } : {}),
        "public/index.html": INDEX_HTML,
        Dockerfile: dockerfileSource(ts),
        ".dockerignore": "node_modules\n.git\ndist\n",
        ".gitignore": "node_modules\ndist\n"
    };
}

/**
 * `npx fulmine.js create <dir> [--ts]`
 *
 * @param {string[]} argv everything after the command
 * @returns {number} exit code
 */
function create(argv) {
    const ts = argv.includes("--ts");
    const given = argv.find((arg) => !arg.startsWith("--"));
    if (!given) {
        console.error(`Usage: npx ${SELF} create <dir> [--ts]`);
        return 1;
    }
    const dir = path.resolve(given);
    // a name npm accepts: what the directory is called, lowercased, anything else a dash
    const name =
        path
            .basename(dir)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-") || "app";

    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        console.error(`${dir} is not empty. Nothing was written: this only starts a project, it does not join one.`);
        return 1;
    }

    const files = projectFiles(name, ts);
    for (const [file, content] of Object.entries(files)) {
        const full = path.join(dir, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        console.log(`wrote ${path.join(given, file)}`);
    }

    console.log(`\nNext:\n`);
    console.log(`  cd ${given}`);
    console.log(`  npm install`);
    console.log(`  npm run dev${ts ? "                 # or npm run build && npm start" : ""}\n`);
    console.log(
        `The Dockerfile uses node:${nodeMajor()}-trixie, since Alpine and bookworm cannot load µWebSockets.js.`
    );
    console.log(`\`npx ${SELF} verify\` says whether this machine can, before you install anything.\n`);
    return 0;
}

module.exports = { create, projectFiles };
