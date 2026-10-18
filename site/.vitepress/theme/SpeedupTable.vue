<script setup lang="ts">
// Every scenario of the CI benchmark, from the snapshot site/speedups.mjs writes: Fulmine against
// Express on the same runner, the median of the last runs and the lowest and highest of them.
import data from "./speedups.json";

const ORDER = ["routing", "middlewares", "connections", "engines", "streaming"];

type Figure = { min: number; median: number; max: number; runs: number };

// the groups the text quotes ("plain", "tables") have no category, only scenarios go in the table
const groups = ORDER.map((category) => ({
    category,
    rows: Object.entries(data.figures as Record<string, Figure>)
        .filter(([name]) => name.startsWith(category + "/"))
        .map(([name, figure]) => ({ name: name.slice(category.length + 1), ...figure }))
        .sort((a, b) => b.median - a.median)
})).filter((group) => group.rows.length > 0);

const x = (value: number) => `${value.toFixed(value >= 10 ? 1 : 2)}x`;
</script>

<template>
    <table class="fm-speedups">
        <thead>
            <tr>
                <th>scenario</th>
                <th>median</th>
                <th>lowest to highest</th>
                <th>runs</th>
            </tr>
        </thead>
        <tbody v-for="group in groups" :key="group.category">
            <tr>
                <th colspan="4">{{ group.category }}</th>
            </tr>
            <tr v-for="row in group.rows" :key="row.name">
                <td>
                    <code>{{ row.name }}</code>
                </td>
                <td>{{ x(row.median) }}</td>
                <td>{{ x(row.min) }} to {{ x(row.max) }}</td>
                <td>{{ row.runs }}</td>
            </tr>
        </tbody>
    </table>
</template>
