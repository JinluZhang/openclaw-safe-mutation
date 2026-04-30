import type { ProtectedFieldDefinition } from "./field-schema.js";
import type { DiffItem, ResolvedPatch } from "./intent-types.js";
import { getValueAtPath } from "./object-path.js";

export function buildDiffItems(
  beforeSnapshot: Record<string, unknown>,
  afterSnapshot: Record<string, unknown>,
  resolvedPatch: ResolvedPatch,
  fieldSchema: readonly ProtectedFieldDefinition[]
): DiffItem[] {
  const fieldsById = new Map(
    fieldSchema.map((field) => [field.fieldId, field] as const)
  );

  return resolvedPatch.fieldChanges.map((fieldChange) => {
    const field = fieldsById.get(fieldChange.fieldId);
    const valuePath = field?.readPath ?? fieldChange.fieldId;

    return {
      fieldId: fieldChange.fieldId,
      label: field?.label ?? fieldChange.fieldId,
      before: getValueAtPath(beforeSnapshot, valuePath),
      after: getValueAtPath(afterSnapshot, valuePath),
      display: field?.display
    };
  });
}
