---
description: Deploy Fulmine.js with Docker, pnpm, private registries and reverse proxies. Check Node.js, platform and native binary requirements before release.
---

# Deploying Fulmine.js

Docker, pnpm, a private npm registry, and a proxy in front. Requirements first: Node 22, 24 or 26 on x64 or arm64, glibc 2.38 or newer, and no Bun. `npx fulmine.js verify` checks all of it in one run.

## Docker

Three things about µWebSockets.js make a Dockerfile that works for Express fail here, and all three have easy answers:

- **No Alpine, and no Debian bookworm either.** µWebSockets.js ships prebuilt binaries linked against glibc 2.38 or newer. Alpine images use musl, so the binary does not load at all; `node:26` and `node:26-slim` are Debian bookworm, whose glibc 2.36 fails at startup with `GLIBC_2.38' not found`. Use the trixie variants: `node:26-trixie-slim` and up.
- **`git` must be there when `npm install` runs.** µWebSockets.js is not on npm; it is installed straight from GitHub (`github:uNetworking/uWebSockets.js`), and npm uses git to fetch it. Full images like `node:26-trixie` have git; `-slim` ones do not.
- **git must be allowed to speak https.** Where the build environment rewrites GitHub URLs to ssh, which some CI images and company-wide git configs do, the fetch asks for a key the image does not have and the install dies on a permission denied that never names µWebSockets.js. One line before `npm ci` puts it back:

    ```dockerfile
    RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
    ```

The clean way to satisfy the first two is a multi-stage build: install with the full image, run with the slim one.

```dockerfile
FROM node:26-trixie AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

A single-stage `node:26-trixie-slim` image works too if you `apt-get install -y git ca-certificates` before `npm ci`. Prebuilt binaries exist for x64 and arm64 on Linux, macOS and Windows, so nothing is compiled at install time either way.

## pnpm

pnpm 10.26 and later refuse a dependency of a dependency that comes from git, and µWebSockets.js is
one, so on a clean project the install stops before anything runs:

```
$ pnpm add fulmine.js
ERR_PNPM_EXOTIC_SUBDEP  Exotic dependency "uWebSockets.js" (resolved via git-repository) is not
allowed in subdependencies when blockExoticSubdeps is enabled
```

The same rule allows a git dependency that is the project's own. So the project takes
µWebSockets.js on itself, at the tag fulmine pins, and an override drops the copy fulmine asks for.
One command writes both lines, and `npx fulmine.js create my-app --pnpm` starts a new project with
them already in (it also reads that it was started by `pnpm dlx`):

```sh
npx fulmine.js pnpm             # writes the two lines below, then: pnpm install
npx fulmine.js pnpm --dry-run   # say what it would write, write nothing
```

```yaml
# pnpm-workspace.yaml: pnpm 11 reads its settings only from here, not from package.json or .npmrc
overrides:
    "fulmine.js>uWebSockets.js": "-"
```

```json
// package.json
"dependencies": {
    "fulmine.js": "^5",
    "uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.69.0"
}
```

Nothing is turned off, and nothing is redistributed: µWebSockets.js still comes from uNetworking's
repository, fetched by pnpm as your dependency. What it costs is that the tag is now yours to
move. Nothing is left to memory: when fulmine changes its pin, the server says so once at startup
(`uWebSockets.js 20.68.0 is installed, this version was tested with 20.69.0`), `npx fulmine.js verify`
says the two differ, and running `npx fulmine.js pnpm` again writes the new one. Each pin change is
also a line in the changelog.

Two other ways through, for completeness. `blockExoticSubdeps: false` in `pnpm-workspace.yaml`
turns the check off for the whole project, so any dependency of a dependency may then come from
git or a URL. And serving µWebSockets.js from a registry of your own, which is the next section,
with the override under `overrides` in `pnpm-workspace.yaml` rather than in `package.json`: that
is the one that also works where git is refused for other reasons.

`npx fulmine.js verify` reads the lockfile, the `packageManager` field and all three, and says which
case the project is in. There was a request upstream to publish µWebSockets.js to npm, and the answer
is a firm no for reasons of their own, so this section stays:
[uNetworking/uWebSockets.js#1312](https://github.com/uNetworking/uWebSockets.js/issues/1312).

## Behind a private registry

µWebSockets.js is not on npm, it is installed from GitHub, and npm allows that by default, so an
ordinary `npm install fulmine.js` needs nothing from this section. It is here for the builds that
have turned git dependencies off, or that cannot reach github.com at all:

```
allow-git=none   npm error code EALLOWGIT
                 npm error Fetching packages of type "git" have been disabled
                 npm error Refusing to fetch "uWebSockets.js@github:uNetworking/uWebSockets.js#v20.69.0"

allow-git=root   npm error code EALLOWGIT
                 npm error Fetching non-root packages of type "git" have been disabled
```

`root` is the one that surprises people: it allows a git dependency your own `package.json` asks
for, and still refuses this one, because it is asked for by fulmine rather than by you.

The answer is to put µWebSockets.js in your own registry and point at it from there. Three steps,
and nothing is compiled on the way: the tarball is what uNetworking already publishes on the tag,
prebuilt binaries included.

**1. Pack the tag.** No clone needed, npm takes the git spec directly:

```sh
npm pack "github:uNetworking/uWebSockets.js#v20.69.0"
```

Read the version out of [`package.json`](../package.json) rather than copying the one above, since
it moves with each release of this package.

**2. Publish it to your registry.**

```sh
npm publish uWebSockets.js-20.69.0.tgz --registry https://registry.internal/
```

The tarball is around 33 MB, because it carries a binary for every Node ABI and platform, and that
is larger than several defaults along the way. Verdaccio refuses it at `max_body_size: 10mb`,
and an nginx in front of any registry refuses it at `client_max_body_size 1m`. Both answer
`413 Payload Too Large` without ever naming µWebSockets.js, so raise them before deciding the
tarball is broken:

```yaml
# verdaccio config.yaml
max_body_size: 200mb
```

**3. Override the git spec in your application.** The version is the same one you packed:

```json
{
    "dependencies": { "fulmine.js": "5.17.0" },
    "overrides": { "uWebSockets.js": "20.69.0" }
}
```

`npm install` and `npm ci` both work from here with git off, and the lockfile resolves to your
registry with an integrity hash, so nothing reaches for git at install time:

```json
"node_modules/uWebSockets.js": {
    "version": "20.69.0",
    "resolved": "https://registry.internal/uWebSockets.js/-/uWebSockets.js-20.69.0.tgz",
    "integrity": "sha512-kO7bcc/Hy3K6YnAVKBCu9ffYC1tl/ccDzDJqVK/GAO81XRRL+R1VmJP8mReg..."
}
```

One thing to tell your security team before their scanner does: the lockfile still contains the
line `"uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.69.0"`. That is fulmine's declared
range, not a resolution, and a scanner that reads what is declared rather than what was installed
will report a git dependency that the install never used.

## Behind a proxy

`trust proxy` works as it does in Express: set it and `req.ip`, `req.ips`, `req.protocol` and
`req.hostname` are read from `X-Forwarded-*` when the connection comes from a peer you trust.

Fulmine adds the other way of being told, the one that does not use headers at all. HAProxy, AWS
NLB, nginx with `proxy_protocol` and Envoy can prepend a **PROXY protocol** preamble to the
connection, and µWebSockets.js parses it. Off by default, and one line turns it on:

```js
app.set("trust proxy protocol", true);
// req.ip, req.socket.remoteAddress and everything reading them are now the address the proxy
// declared, and fall back to the socket's own on a connection that sent no preamble
```

> [!WARNING]
> **Only turn this on when nothing but the proxy can reach the server.** µWS reads the preamble
> from whoever sends it. There is no way to say which peers may use it, so on a port open to the
> internet the first sixteen bytes of any connection are enough for a client to become `10.0.0.1`
> for your rate limiter, your allow list and your audit log. Bind to the private interface, or
> keep this off.

`trust proxy` and this can both be on. The preamble decides what the connection's address is, and
`trust proxy` then peels `X-Forwarded-For` off that, so a proxy that sends both is read the way it
meant. It is the binary v2 preamble that µWS reads, not the v1 text line, so a connection starting
with `PROXY TCP4 ...` is answered as a malformed request. Runnable, with a client that writes one:
[`examples/proxy-protocol.js`](../examples/proxy-protocol.js).
