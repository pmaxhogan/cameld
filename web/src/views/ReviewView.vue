<script setup lang="ts">
import type { GroupSummary, ReviewItem } from "@cameld/shared";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { onMounted, ref } from "vue";
import { apiGet, errorText } from "../api.ts";
import { fmtTime, readMetrics, severityOf } from "../format.ts";
import ReviewDetail from "./ReviewDetail.vue";

defineProps<{ styleUrl: string | null }>();

const items = ref<ReviewItem[] | null>(null);
const selected = ref<ReviewItem | null>(null);
const error = ref<string | null>(null);
const result = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    items.value = await apiGet<ReviewItem[]>("/api/review");
    error.value = null;
  } catch (e) {
    error.value = errorText(e);
  }
}

function select(item: ReviewItem): void {
  selected.value = item;
  result.value = null;
}

async function decided(summary: GroupSummary): Promise<void> {
  result.value = `Group ${summary.id} is now ${summary.status}`;
  selected.value = null;
  await load();
}

onMounted(load);
</script>

<template>
  <section class="review">
    <h2>Review queue</h2>
    <Message v-if="error" severity="error" data-testid="review-error">{{ error }}</Message>
    <Message v-if="result" severity="success" data-testid="review-result">{{ result }}</Message>
    <p v-if="items === null && !error" data-testid="review-loading">Loading...</p>
    <p v-else-if="items !== null && items.length === 0" data-testid="review-empty">
      Nothing waiting for review.
    </p>
    <ul v-if="items" class="items">
      <li v-for="item in items" :key="item.id">
        <button
          type="button"
          class="item"
          :class="{ active: selected?.id === item.id }"
          data-testid="review-item"
          @click="select(item)"
        >
          <span>{{ fmtTime(item.startMs) }}</span>
          <span>{{ item.name ?? item.sportType ?? item.id }}</span>
          <Tag :value="readMetrics(item.match).decision" :severity="severityOf(item.status)" />
          <span class="muted">{{ item.parkedReason ?? item.status }}</span>
        </button>
      </li>
    </ul>
    <ReviewDetail
      v-if="selected"
      :key="selected.id"
      :item="selected"
      :style-url="styleUrl"
      @decided="decided"
    />
  </section>
</template>

<style scoped>
.items {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.25rem;
}
.item {
  width: 100%;
  display: grid;
  grid-template-columns: 10rem 1fr auto 12rem;
  gap: 0.75rem;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.item.active {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.08);
}
.muted {
  opacity: 0.75;
}
</style>
