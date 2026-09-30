import { z } from "zod";

/** Body of GET /healthz. Unauthenticated by design: the Docker healthcheck uses it. */
export const healthSchema = z.object({
  ok: z.literal(true),
  version: z.string().min(1),
});

export type Health = z.infer<typeof healthSchema>;

/** Parse an unknown value as a Health body, or return null when it is not one. */
export function parseHealth(value: unknown): Health | null {
  const result = healthSchema.safeParse(value);
  return result.success ? result.data : null;
}
