---
layout: home
markdownStyles: false
title: Fulmine.js | Fast Express 5 alternative for Node.js
titleTemplate: false
description: Fulmine.js is a drop-in Express 5 replacement for Node.js, powered by uWebSockets.js. Keep your API and middleware with faster native routing.
---

<script setup>
import CopyCommand from '../site/.vitepress/theme/CopyCommand.vue'
</script>

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
<p class="fm-hero-note">Open source. Express 5 compatible. Built for Node.js.</p>
</div>
<div class="fm-speed-field">
<div class="fm-field-top"><span>NATIVE ENGINE</span><span>01 / µWS</span></div>
<img class="fm-speed-art" src="/speed-field.svg" alt="" width="600" height="500" fetchpriority="high" decoding="async">
<div class="fm-speed-readout"><span class="fm-up-to">UP TO</span><strong>22<span>×</span></strong><span class="fm-speed-label">faster than Express<span>on large route tables</span></span></div>
<a class="fm-field-footnote" href="/performance">Measured in CI. Explore the conditions <span aria-hidden="true">↗</span></a>
</div>
</section>

<div class="fm-proof-strip">
<div class="fm-wrap fm-proof-grid">
<div><span class="fm-proof-symbol" aria-hidden="true">↗</span><p><strong>Native speed</strong><span>Routing in C++, powered by µWS</span></p></div>
<div><span class="fm-proof-symbol" aria-hidden="true">=</span><p><strong>Same Express API</strong><span>Your middleware keeps working</span></p></div>
<div><span class="fm-proof-symbol" aria-hidden="true">✓</span><p><strong>1,130 / 1,130</strong><span>Express 5's own tests passing</span></p></div>
</div>
</div>

<section class="fm-section fm-wrap fm-migration" aria-labelledby="migration-title">
<div class="fm-section-copy">
<p class="fm-eyebrow"><span class="fm-section-number">01</span> FAMILIAR BY DESIGN</p>
<h2 id="migration-title">Change the import.<br>Keep the good parts.</h2>
<p>You already know how to use Fulmine. Keep your routes, your middleware and the way you build. Give them a faster foundation.</p>
<a class="fm-text-link" href="/migrating">The migration guide <span aria-hidden="true">→</span></a>
<a class="fm-subtle-link" href="/differences">Read the differences from Express</a>
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
<div class="fm-metric"><p class="fm-metric-value">1.3–4.9<span>×</span></p><h3>Plain routing</h3><p>The everyday requests.<br>Less framework overhead.</p><div class="fm-meter" aria-hidden="true"><span style="--meter: 25%"></span></div></div>
<div class="fm-metric"><p class="fm-metric-value">7.5–16.4<span>×</span></p><h3>1,000 routes</h3><p>Your route table grows.<br>The native router keeps up.</p><div class="fm-meter" aria-hidden="true"><span style="--meter: 82%"></span></div></div>
<div class="fm-metric"><p class="fm-metric-value">7.7–19.9<span>×</span></p><h3>1,000 parameterized routes</h3><p>More paths. More parameters.<br>This is where native shines.</p><div class="fm-meter" aria-hidden="true"><span style="--meter: 100%"></span></div></div>
</div>
<p class="fm-benchmark-note">Throughput relative to Express. Ranges from 12 CI runs on Node 26 across four runner configurations. Results depend on workload and hardware; shared work such as JSON parsing or compression sees smaller gains. <a href="/performance">Methodology &amp; limitations ↗</a></p>
</div>
</section>

<section class="fm-section fm-wrap fm-ecosystem" aria-labelledby="ecosystem-title">
<div class="fm-section-copy">
<p class="fm-eyebrow"><span class="fm-section-number">03</span> BRING YOUR STACK</p>
<h2 id="ecosystem-title">All your favourites.<br>Already on board.</h2>
<p>From a single endpoint to a full-stack framework. Integrations run against both Express and Fulmine in CI, with their outputs compared.</p>
<a class="fm-text-link" href="/compatibility">Explore compatibility <span aria-hidden="true">→</span></a>
</div>
<div class="fm-stack">
<div class="fm-stack-row"><p class="fm-stack-label">YOUR FRAMEWORKS</p><p class="fm-frameworks"><span>NestJS</span><span>Next.js</span><span>Astro</span><span>SvelteKit</span><span>React Router</span><span>Angular SSR</span></p></div>
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
