function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getValueAtPath(
  source: Record<string, unknown>,
  path: string
): unknown {
  const segments = path.split(".");
  let current: unknown = source;

  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

export function setValueAtPath(
  source: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const clone = structuredClone(source);
  const segments = path.split(".");
  let current: Record<string, unknown> = clone;

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];

    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  current[segments.at(-1)!] = value;
  return clone;
}
