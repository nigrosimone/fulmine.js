<script setup lang="ts">
// The HttpArena composite from the top of the board down to Fulmine, then ten more flagship frameworks,
// and Express and Fastify wherever they land, the two a reader compares with. From the snapshot written
// by site/arena.mjs, rendered at build time, so the page fetches nothing from the arena.
import { computed, ref } from "vue";
import arena from "./arena.json";

const after = 10;
const KNOWN = ["express", "fastify"];
// TypeScript too: Bun, Elysia and Hono are JavaScript frameworks for whoever is choosing one
const views = { all: "All languages", js: "JavaScript" };
const view = ref<keyof typeof views>("all");
const rows = computed(() => {
    const league =
        view.value === "all" ? arena.rows : arena.rows.filter((row) => row.lang === "JS" || row.lang === "TS");
    const shown = league.slice(0, league.findIndex((row) => row.slug === "fulmine.js") + after + 1);
    const known = league.filter((row) => KNOWN.includes(row.slug) && !shown.includes(row));
    return known.length > 0 ? [...shown, { slug: "", gap: true }, ...known] : shown;
});

// one scale for both views, so a bar keeps its length when the view changes
const top = arena.rows[0].score;
const date = new Date(arena.date).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
});
</script>

<template>
    <figure class="fm-arena">
        <div class="fm-arena-views" role="group" aria-label="Frameworks shown">
            <button
                v-for="(label, key) in views"
                :key="key"
                type="button"
                :aria-pressed="view === key"
                @click="view = key"
            >
                {{ label }}
            </button>
        </div>
        <ul class="fm-arena-rows">
            <li
                v-for="row in rows"
                :key="row.slug || 'gap'"
                :class="{
                    'fm-arena-us': row.slug === 'fulmine.js',
                    'fm-arena-known': KNOWN.includes(row.slug),
                    'fm-arena-gap': row.gap
                }"
            >
                <template v-if="!row.gap">
                    <span class="fm-arena-rank">#{{ view === "js" ? row.jsRank : row.rank }}</span>
                    <span class="fm-arena-name"
                        >{{ row.slug }}<small>{{ row.lang }}</small></span
                    >
                    <span class="fm-arena-track" aria-hidden="true">
                        <span :style="{ width: `${(row.score / top) * 100}%` }"></span>
                    </span>
                    <span class="fm-arena-score">{{ row.score.toLocaleString("en-US") }}</span>
                </template>
            </li>
        </ul>
        <figcaption>
            HttpArena H/1.1 composite on {{ date }}, ranks
            {{
                view === "js"
                    ? "among the JavaScript and TypeScript frameworks"
                    : `on the whole board of ${arena.total}`
            }}. Every framework ahead of Fulmine, after it only the flagship ones, and Express and Fastify wherever they
            land. Same tests and same 64-core machine for all.
        </figcaption>
    </figure>
</template>
