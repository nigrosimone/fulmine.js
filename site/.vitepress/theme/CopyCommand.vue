<script setup lang="ts">
import { onUnmounted, ref } from "vue";

const props = defineProps<{ command: string }>();
const message = ref("");
let reset: ReturnType<typeof setTimeout> | undefined;

async function copy() {
    clearTimeout(reset);
    try {
        await navigator.clipboard.writeText(props.command);
        message.value = "Copied!";
    } catch {
        message.value = "Select the command to copy it.";
    }
    reset = setTimeout(() => (message.value = ""), 3000);
}

onUnmounted(() => clearTimeout(reset));
</script>

<template>
    <div class="fm-install">
        <span class="fm-install-prompt" aria-hidden="true">$</span>
        <code>{{ command }}</code>
        <button type="button" aria-label="Copy install command" @click="copy">
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
            >
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </svg>
        </button>
        <span class="fm-copy-feedback" role="status">{{ message }}</span>
    </div>
</template>
