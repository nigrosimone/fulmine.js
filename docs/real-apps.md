---
description: LibreChat, n8n and Actual Budget on Fulmine instead of Express. Their own test suites pass, and LibreChat and Actual spend 9% to 11% less CPU with no change, up to 28% with a five line patch.
---

<script setup>
import RealAppsChart from '../site/.vitepress/theme/RealAppsChart.vue'
import data from '../site/.vitepress/theme/realapps.json'

const usd = (v) => '$' + Math.round(v).toLocaleString('en-US')
const ratio = (v) => v == null ? '' : v.toFixed(2) + 'x'
const lessTotal = (p) => Math.round((1 - p.year['fulmine + patch'].total / p.year.express.total) * 100)
</script>

# Real applications

A hello world says little about an application with a database, twenty middlewares and a session
check on every request. So Fulmine was put in place of Express in real open source projects, with no
change to their code, and asked two things: do their own tests still pass, and how much CPU do their
own endpoints take. Everything, scripts and raw results, is in
[fulmine-compat](https://github.com/nigrosimone/fulmine-compat).

## Their tests

Each suite runs on the Express the project ships with, on plain Express 5, and on Fulmine. Only a
test that passes on Express and fails on Fulmine would count against it.

| project                                                              | its own Express        | plain Express 5         | Fulmine                 |
| -------------------------------------------------------------------- | ---------------------- | ----------------------- | ----------------------- |
| [Actual Budget](https://github.com/actualbudget/actual), sync server | 595 passed             | 595 passed              | 595 passed              |
| [LibreChat](https://github.com/danny-avila/LibreChat), API           | 4,840 passed, 6 failed | 4,818 passed, 28 failed | 4,842 passed, 4 failed  |
| [n8n](https://github.com/n8n-io/n8n), CLI integration suite          | 5,618 passed, 9 failed | 6,123 passed, 14 failed | 6,109 passed, 10 failed |

No test fails on Fulmine that passes on Express: what fails on Fulmine fails on Express too, on the
machine the suites ran on. One setting was needed, `body methods`, since Express reads a body on any
verb and Fulmine by default only on POST, PUT, PATCH and QUERY; LibreChat's DELETE routes take a
body, see [differences](/differences).

## Their endpoints

LibreChat and Actual Budget, under the load of their own web client. n8n is left out here: it builds
its server with `http.createServer(app)`, so without a change Fulmine serves it through node:http,
which is a smaller story.

<RealAppsChart />

The same requests their web client sends, one by one, CPU per request against Express:

<table>
<thead><tr><th>endpoint</th><th>what it is</th><th>no change</th><th>patched</th></tr></thead>
<tbody v-for="p in data.projects" :key="p.name">
<tr><th colspan="4">{{ p.title }}</th></tr>
<tr v-for="e in p.endpoints" :key="e.name"><td><code>{{ e.name }}</code></td><td>{{ e.what }}</td><td>{{ ratio(e.plain) }}</td><td>{{ ratio(e.patch) }}</td></tr>
</tbody>
</table>

Where the framework is the work, the health check, the page, a static file, the gain is large. Where
the database is the work it is smaller, and still there.

The patch moves the project to Fulmine's own compression and static files, `express.compression()`
and `express.static(dir, { preCompressed: true })`, see [performance](/performance#performance-tips):
[five lines in LibreChat](https://github.com/nigrosimone/fulmine-compat/blob/main/patches/librechat.diff),
[one in Actual](https://github.com/nigrosimone/fulmine-compat/blob/main/patches/actual.diff) plus a
build step that writes the brotli and gzip files.

## What it is worth

These servers are light, so it depends on scale. With a million active users a day, on
{{ data.prices.cloud }} with a task of 1 vCPU and {{ data.prices.taskGb }} GB per process at
{{ Math.round(data.prices.utilization * 100) }}% CPU and ${{ data.prices.egressGb }} per GB out:

<table>
<thead><tr><th>a year</th><th>Express</th><th>Fulmine, no change</th><th>Fulmine, patched</th></tr></thead>
<tbody>
<tr v-for="p in data.projects" :key="p.name"><td>{{ p.title }}</td><td>{{ usd(p.year.express.total) }}</td><td>{{ usd(p.year.fulmine.total) }}</td><td>{{ usd(p.year['fulmine + patch'].total) }}, -{{ lessTotal(p) }}%</td></tr>
</tbody>
</table>

Compute is a small part of that bill and outbound traffic the large one. Without a change Fulmine
takes 9% to 11% of the compute, which barely shows in the total. With the patch most of the saving is
the web app going out compressed, which Express can also do through a plugin: what Fulmine adds is
one option, and less CPU per file. A single small instance sees no difference on the invoice, it pays
its minimum either way.

## How it was measured

One ARM core of Oracle Cloud (Neoverse N1, the core of AWS Graviton2) for the server, wrk on two
others, the database on the fourth. Both servers start from one checkout as their Docker image starts
them, each with its own database and the same seed. Five alternating rounds per endpoint, CPU read
from `/proc`, and an A/A run of Express against Express to measure the noise. Measured on
{{ data.date }}, Express {{ data.projects[0].express }}, Fulmine {{ data.projects[0].fulmine }}. To run
it again, see the [repository](https://github.com/nigrosimone/fulmine-compat).
