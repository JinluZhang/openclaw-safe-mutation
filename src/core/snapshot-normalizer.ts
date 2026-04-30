import { createHash } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const child = value[key];

      if (child !== undefined) {
        normalized[key] = normalizeValue(child);
      }
    }

    return normalized;
  }

  return value;
}

export function normalizeSnapshot(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  return normalizeValue(snapshot) as Record<string, unknown>;
}

export function hashNormalizedSnapshot(
  normalizedSnapshot: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedSnapshot))
    .digest("hex");
}
