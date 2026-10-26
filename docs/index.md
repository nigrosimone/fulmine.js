---
layout: home
markdownStyles: false
title: Fulmine.js | Fast Express 5 alternative for Node.js
titleTemplate: false
description: Fulmine.js is a drop-in Express 5 replacement for Node.js, powered by uWebSockets.js. Keep your API and middleware with faster native routing.
---

<!--
<script setup>
import CopyCommand from '../site/.vitepress/theme/CopyCommand.vue'
import ArenaChart from '../site/.vitepress/theme/ArenaChart.vue'
import arena from '../site/.vitepress/theme/arena.json'
import RealAppsChart from '../site/.vitepress/theme/RealAppsChart.vue'
import SpeedRace from '../site/.vitepress/theme/SpeedRace.vue'
import realapps from '../site/.vitepress/theme/realapps.json'

// the bigger of the two cuts, each against Express on the same machine
const bestCut = Math.max(...realapps.projects.map((p) => Math.round((1 - p.day['fulmine + patch'].cpuMs / p.day.express.cpuMs) * 100)))
</script>
-->

<main class="fulmine-home">
<section class="fm-hero fm-wrap" aria-labelledby="hero-title">
<div class="fm-hero-copy">
<p class="fm-eyebrow"><span class="fm-status-dot" aria-hidden="true"></span> EXPRESS, SUPERCHARGED.</p>
<h1 id="hero-title">Same Express.<br><span>Different speed.</span></h1>
<p class="fm-intro">Your routes. Your middleware. Your code.<br>A faster engine underneath it all.</p>
<p class="fm-description">The drop-in Express 5 replacement, powered by uWebSockets.js. Move to the fast lane with a single import.</p>
<div class="fm-actions">
<a class="fm-button fm-button-primary" href="/migrating">Start your engine <span aria-hidden="true">↗</span></a>
<a class="fm-text-link" href="/performance">See the benchmarks <span aria-hidden="true">→</span></a>
</div>
<CopyCommand command="npm install fulmine.js" />
<ul class="fm-hero-proof">
<li><a href="https://www.http-arena.com/#sort=rps:-1&q=Js"><strong>#{{ arena.jsRank }} in JavaScript</strong> on HttpArena</a></li>
<li><strong>1,153 / 1,153</strong> Express 5 tests passing</li>
</ul>
<p class="fm-hero-note">Open source. Express 5 compatible. Built for Node.js.</p>
</div>
<div class="fm-speed-field">
<div class="fm-field-top"><span>NATIVE ENGINE</span><span>01 / µWS</span></div>
<img class="fm-speed-art" src="/speed-field.svg" alt="" width="600" height="500" fetchpriority="high" decoding="async">
<div class="fm-speed-readout"><span class="fm-up-to">UP TO</span><strong><!--speedup:routing/routes-1000-params:p90-->14<!--/speedup--><span>×</span></strong><span class="fm-speed-label">faster than Express<span>on 1,000 parameterized routes</span></span></div>
<a class="fm-field-footnote" href="/performance">90th percentile of the last 20 CI runs, median <!--speedup:routing/routes-1000-params:median-->10<!--/speedup-->×. Explore the conditions <span aria-hidden="true">↗</span></a>
</div>
</section>

<div class="fm-proof-strip">
<div class="fm-wrap fm-proof-grid">
<div><span class="fm-proof-symbol" aria-hidden="true">↗</span><p><strong><!--speedup:tables:median-->10<!--/speedup-->× median</strong><span>on large route tables, measured on every push</span></p></div>
<div><span class="fm-proof-symbol" aria-hidden="true">=</span><p><strong>1 line to migrate</strong><span>Your routes and middleware keep working</span></p></div>
<div><span class="fm-proof-symbol" aria-hidden="true">✓</span><p><strong>9 frameworks</strong><span>NestJS, Next.js, Astro and more, tested in CI</span></p></div>
</div>
</div>

<section class="fm-section fm-wrap fm-migration" aria-labelledby="migration-title">
<div class="fm-section-copy">
<p class="fm-eyebrow"><span class="fm-section-number">01</span> FAMILIAR BY DESIGN</p>
<h2 id="migration-title">Change the import.<br>Keep the good parts.</h2>
<p>You already know how to use Fulmine. Keep your routes, your middleware and the way you build. Give them a faster foundation.</p>
<a class="fm-text-link" href="/migrating">The migration guide <span aria-hidden="true">→</span></a>
<a class="fm-subtle-link" href="/differences">Read the differences from Express</a>
<p class="fm-try"><strong>See what it does with your app.</strong> The first command switches the import, the second lists which of your routes run native.</p>
<CopyCommand command="npx fulmine.js migrate" />
<CopyCommand command="npx fulmine.js profile" />
</div>
<div class="fm-code-window">
<div class="fm-code-title"><span><i aria-hidden="true"></i> app.js</span><span>ONE LINE. ALL THE DIFFERENCE.</span></div>
<div class="fm-code-body vp-doc">

```js
const express = require("express"); // [!code --]
const express = require("fulmine.js"); // [!code ++]

const app = express();

app.get("/", (req, res) => {
    res.send("Hello, fast lane.");
});

app.listen(3000);
```

</div>
<div class="fm-code-footer"><span class="fm-status-dot" aria-hidden="true"></span> Same API. A different engine.</div>
</div>
</section>

<section class="fm-performance" aria-labelledby="performance-title">
<div class="fm-wrap">
<div class="fm-performance-heading">
<div><p class="fm-eyebrow"><span class="fm-section-number">02</span> LESS OVERHEAD. MORE GO.</p><h2 id="performance-title">Fast where<br>it counts.</h2></div>
<div><p>Native routing. Less work per request. More room for your application.</p><a class="fm-text-link" href="/performance">Go under the hood <span aria-hidden="true">↗</span></a></div>
</div>
<div class="fm-metrics">
<div class="fm-metric"><p class="fm-metric-value"><!--speedup:plain:dash-->1.2-3.2<!--/speedup--><span>×</span></p><h3>Plain routing</h3><p>The everyday requests.<br>Less framework overhead.</p><SpeedRace figure="plain" /></div>
<div class="fm-metric"><p class="fm-metric-value"><!--speedup:routing/routes-1000:dash-->8.0-12.1<!--/speedup--><span>×</span></p><h3>1,000 routes</h3><p>Your route table grows.<br>The native router keeps up.</p><SpeedRace figure="routing/routes-1000" /></div>
<div class="fm-metric"><p class="fm-metric-value"><!--speedup:routing/routes-1000-params:dash-->8.0-13.8<!--/speedup--><span>×</span></p><h3>1,000 parameterized routes</h3><p>More paths. More parameters.<br>This is where native shines.</p><SpeedRace figure="routing/routes-1000-params" /></div>
</div>
<p class="fm-benchmark-note">Throughput relative to Express. Ranges are the 10th to 90th percentile of <!--speedup:period:text-->the last 20 CI runs, 20 October 2026 to 26 October 2026<!--/speedup-->, on Node 26 and on whatever runner GitHub gives each run; the dots move at the upper end of each range. Results depend on workload and hardware; shared work such as JSON parsing or compression sees smaller gains. <a href="/performance">Methodology &amp; limitations ↗</a></p>
</div>
</section>

<section class="fm-section fm-wrap fm-arena-section" aria-labelledby="arena-title">
<div class="fm-section-copy">
<p class="fm-eyebrow"><span class="fm-section-number">03</span> MEASURED BY OTHERS</p>
<h2 id="arena-title">#{{ arena.rank }} of {{ arena.total }}.<br>#{{ arena.jsRank }} in JavaScript.</h2>
<p>HttpArena is an open benchmark: every framework runs the same tests on the same machine. This is Fulmine next to the frameworks you know, in JavaScript and in the other languages.</p>
<a class="fm-text-link" href="https://www.http-arena.com/">See the full board</a>
<a class="fm-subtle-link" href="https://www.http-arena.com/frameworks/fulmine.js/">Fulmine.js on HttpArena</a>
</div>
<ArenaChart />
</section>

<section class="fm-section fm-wrap fm-arena-section" aria-labelledby="realapps-title">
<div class="fm-section-copy">
<p class="fm-eyebrow"><span class="fm-section-number">04</span> REAL APPLICATIONS</p>
<h2 id="realapps-title">Real apps.<br>Up to {{ bestCut }}% less CPU.</h2>
<p><a href="https://github.com/danny-avila/LibreChat">LibreChat</a>, <a href="https://github.com/n8n-io/n8n">n8n</a> and <a href="https://github.com/actualbudget/actual">Actual Budget</a> on Fulmine, with no change to their code: their test suites pass as they do on Express. Actual spends 16% less CPU per user with no change, LibreChat 24% with Fulmine's own compression and static files.</p>
<a class="fm-text-link" href="/real-apps">See how it was measured <span aria-hidden="true">→</span></a>
<a class="fm-subtle-link" href="https://github.com/nigrosimone/fulmine-compat">The scripts and the raw results</a>
</div>
<RealAppsChart />
</section>

<section class="fm-section fm-wrap fm-ecosystem" aria-labelledby="ecosystem-title">
<div class="fm-section-copy">
<p class="fm-eyebrow"><span class="fm-section-number">05</span> BRING YOUR STACK</p>
<h2 id="ecosystem-title">All your favourites.<br>Already on board.</h2>
<p>From a single endpoint to a full-stack framework. Integrations run against both Express and Fulmine in CI, with their outputs compared.</p>
<a class="fm-text-link" href="/compatibility">Explore compatibility <span aria-hidden="true">→</span></a>
</div>
<div class="fm-stack">
<div class="fm-stack-row"><p class="fm-stack-label">YOUR FRAMEWORKS</p><p class="fm-frameworks"><span>NestJS</span><span>Next.js</span><span>Astro</span><span>SvelteKit</span><span>React Router</span><span>tRPC</span></p></div>
<div class="fm-stack-row"><p class="fm-stack-label">YOUR MIDDLEWARE</p><p class="fm-middleware"><span>helmet</span><span>cors</span><span>passport</span><span>morgan</span><span>multer</span><span>express-session</span></p></div>
<div class="fm-stack-bottom"><span class="fm-status-dot" aria-hidden="true"></span> Familiar tools. Tested together.</div>
</div>
</section>

<section class="fm-wrap fm-extras" aria-label="More built into Fulmine">
<a href="/websockets"><span class="fm-extra-icon" aria-hidden="true">↔</span><h3>Go real-time.</h3><p>Native WebSockets, right alongside your HTTP routes.</p><span class="fm-extra-link">Explore WebSockets <span aria-hidden="true">↗</span></span></a>
<a href="/deployment"><span class="fm-extra-icon" aria-hidden="true">⤴</span><h3>Use every core.</h3><p>Built-in clustering. One port. Ready for your next deployment.</p><span class="fm-extra-link">Deploy Fulmine <span aria-hidden="true">↗</span></span></a>
<a href="/performance#performance-tips"><span class="fm-extra-icon" aria-hidden="true">⌘</span><h3>Know your fast path.</h3><p>Inspect your routes with profile. Understand requests with explain.</p><span class="fm-extra-link">Meet the tools <span aria-hidden="true">↗</span></span></a>
</section>

<section class="fm-wrap fm-start" aria-labelledby="start-title">
<div><p class="fm-eyebrow">LESS FRICTION. MORE MOMENTUM.</p><h2 id="start-title">Your next request.<br><span>Only faster.</span></h2></div>
<div class="fm-start-actions"><a class="fm-button fm-button-primary" href="/migrating">Get started with Fulmine <span aria-hidden="true">↗</span></a><a class="fm-text-link" href="https://github.com/nigrosimone/fulmine.js">Explore the source on GitHub <span aria-hidden="true">↗</span></a></div>
</section>
</main>
