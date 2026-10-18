<script setup lang="ts">
// Two requests going back and forth, one per server: Fulmine's makes as many round trips as the upper
// end of the range its tile shows, for every one of Express's, from the snapshot site/speedups.mjs writes.
import { computed } from "vue";
import data from "./speedups.json";

const props = defineProps<{ figure: string }>();

// one round trip of Express, the same in every tile so the tiles compare with each other
const EXPRESS_TRIP_SECONDS = 10;

// the tile's own figure, so a wider range runs faster; the note under the tiles says which end
const ratio = computed(() => (data.figures as Record<string, { max: number }>)[props.figure]?.max ?? 1);
// alternate makes one run of the animation half a round trip
const express = `${EXPRESS_TRIP_SECONDS / 2}s`;
const fulmine = computed(() => `${EXPRESS_TRIP_SECONDS / 2 / ratio.value}s`);
</script>

<template>
    <div class="fm-race" aria-hidden="true">
        <div class="fm-race-lane">
            <span class="fm-race-name">Express</span>
            <span class="fm-race-track">
                <span class="fm-race-rail" :style="{ animationDuration: express }"
                    ><span class="fm-race-dot"></span
                ></span>
            </span>
        </div>
        <div class="fm-race-lane fm-race-us">
            <span class="fm-race-name">Fulmine</span>
            <span class="fm-race-track">
                <span class="fm-race-rail" :style="{ animationDuration: fulmine }"
                    ><span class="fm-race-dot"></span
                ></span>
            </span>
        </div>
    </div>
</template>
