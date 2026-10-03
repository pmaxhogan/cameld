import type { ApiStatus } from "@cameld/shared";
import { ref } from "vue";
import { apiGet, errorText } from "./api.ts";

/** The latest GET /api/status, shared by every view. */
export const status = ref<ApiStatus | null>(null);
export const statusError = ref<string | null>(null);

export async function refreshStatus(): Promise<void> {
  try {
    status.value = await apiGet<ApiStatus>("/api/status");
    statusError.value = null;
  } catch (error) {
    statusError.value = errorText(error);
  }
}

export const STATUS_POLL_MS = 30_000;
