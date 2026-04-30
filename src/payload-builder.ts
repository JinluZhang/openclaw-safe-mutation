import type { ProtectedFieldDefinition } from "./field-schema.js";
import type { ResolvedPatch } from "./intent-types.js";
import { setValueAtPath } from "./object-path.js";

export function buildWritePayload(
  currentSnapshot: Record<string, unknown>,
  resolvedPatch: ResolvedPatch,
  fieldSchema: readonly ProtectedFieldDefinition[]
): Record<string, unknown> {
  const fieldsById = new Map(
    fieldSchema.map((field) => [field.fieldId, field] as const)
  );
  let nextSnapshot = structuredClone(currentSnapshot);

  for (const fieldChange of resolvedPatch.fieldChanges) {
    const field = fieldsById.get(fieldChange.fieldId);

    if (!field) {
      throw new Error(`Unknown field id in resolved patch: ${fieldChange.fieldId}`);
    }

    nextSnapshot = setValueAtPath(
      nextSnapshot,
      field.readPath,
      fieldChange.normalizedInput
    );
  }

  return nextSnapshot;
}
