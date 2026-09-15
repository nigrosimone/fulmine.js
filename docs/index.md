---
layout: home
title: Fulmine.js
titleTemplate: the drop-in Express 5 replacement, up to 20x faster
hero:
    name: Fulmine.js
    text: The drop-in Express 5 replacement
    tagline: Same API, same middleware, same tests. Built on uWebSockets.js instead of node:http, up to 20x faster where the framework does the work.
    image:
        src: /logo-mark.svg
        alt: Fulmine.js
    actions:
        - theme: brand
          text: Migrate in one line
          link: /migrating
        - theme: alt
          text: Why Fulmine
          link: /why
        - theme: alt
          text: GitHub
          link: https://github.com/nigrosimone/fulmine.js
features:
    - icon: ⚡
      title: Faster than Express, measured
      details: 1.3x to 4.9x on plain routing, 7x to 20x on a large route table, on every CI run. Routes are matched in C++ and a simple enough handler never enters JavaScript.
      link: /performance
      linkText: The numbers and where they come from
    - icon: 🔁
      title: Zero rewrite
      details: helmet, cors, passport, morgan, multer, express-session keep working. Every test runs against real Express first and the output must match byte for byte. Express 5's own suite passes, 1130 of 1130.
      link: /compatibility
      linkText: What is tested
    - icon: 🧩
      title: Your framework works too
      details: NestJS, Next.js, Astro, SvelteKit, React Router, Angular SSR, Apollo, tRPC, tsoa, MCP. Each one served twice in CI, on Express and on Fulmine, and compared.
      link: /compatibility#tested-frameworks
      linkText: Tested frameworks
    - icon: 🛠️
      title: More than Express, when you want it
      details: One process per core on one port, native WebSockets, built-in compression, pre-compressed static files, Server-Timing, PROXY protocol, TLS. All optional.
      link: /websockets
      linkText: WebSockets
    - icon: 🧭
      title: Nothing to guess
      details: npx fulmine.js verify says whether this machine and your Docker image can run it. profile prints what listen() decided about each route. explain tells the story of one request.
      link: /performance#performance-tips
      linkText: profile and explain
    - icon: 📈
      title: Ranked in public
      details: HttpArena and web-frameworks run it on their hardware with their rules. No figure is copied here, the boards are the current ones.
      link: /performance#public-benchmarks
      linkText: Public benchmarks
---

## One line

```js
const express = require("fulmine.js"); // instead of require("express")
```

```sh
npx fulmine.js create my-app        # a new project, with a Dockerfile that works
npx fulmine.js migrate              # an existing one: rewrite the imports, list what to check
```
