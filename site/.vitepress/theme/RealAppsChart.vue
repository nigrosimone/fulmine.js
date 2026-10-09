<script setup lang="ts">
// CPU that one active user costs a real application in a day, on Express, on fulmine with no change,
// and on fulmine with the project's small patch, from the snapshot written by site/realapps.mjs.
import data from "./realapps.json";

const arms = [
    { key: "express", label: "Express", us: false },
    { key: "fulmine", label: "fulmine, no change", us: true },
    { key: "fulmine + patch", label: "fulmine, patched", us: true }
] as const;

const less = (project: (typeof data.projects)[number], arm: string) =>
    Math.round((1 - project.day[arm as keyof typeof project.day].cpuMs / project.day.express.cpuMs) * 100);
</script>

<template>
    <figure class="fm-arena fm-realapps">
        <div v-for="project in data.projects" :key="project.name" class="fm-realapps-project">
            <p class="fm-realapps-title">{{ project.title }}</p>
            <ul class="fm-arena-rows">
                <li v-for="arm in arms" :key="arm.key" :class="{ 'fm-arena-us': arm.us }">
                    <span class="fm-arena-rank">{{ arm.key === "express" ? "" : `-${less(project, arm.key)}%` }}</span>
                    <span class="fm-arena-name">{{ arm.label }}</span>
                    <span class="fm-arena-track" aria-hidden="true">
                        <span
                            :style="{
                                width: `${(project.day[arm.key].cpuMs / project.day.express.cpuMs) * 100}%`
                            }"
                        ></span>
                    </span>
                    <span class="fm-arena-score">{{ project.day[arm.key].cpuMs.toFixed(0) }} ms</span>
                </li>
            </ul>
        </div>
        <figcaption>
            CPU time one active user costs the server in a day: the page, the API calls, the syncs, a new release now
            and then. Their own endpoints with Chrome's headers, one ARM core, Node 24. The noise of the machine is
            under {{ Math.ceil(Math.max(...data.projects.map((p) => p.noise)) * 100) }}%.
        </figcaption>
    </figure>
</template>
