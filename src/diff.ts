import { parameterCatalog } from "./catalog.js";
import type { DiffItem, ResolvedPatch } from "./intent-types.js";
import { getValueAtPath } from "./object-path.js";

export function buildDiffItems(
  beforeSnapshot: Record<string, unknown>,
  afterSnapshot: Record<string, unknown>,
  resolvedPatch: ResolvedPatch
): DiffItem[] {
  const catalogByFieldId = new Map(
    parameterCatalog.map((item) => [item.fieldId, item] as const)
  );

  return resolvedPatch.fieldChanges.map((fieldChange) => {
    const catalogItem = catalogByFieldId.get(fieldChange.fieldId);
    const valuePath = catalogItem?.apiPath ?? fieldChange.fieldId;

    return {
      fieldId: fieldChange.fieldId,
      label: catalogItem?.labels[0] ?? fieldChange.fieldId,
      before: getValueAtPath(beforeSnapshot, valuePath),
      after: getValueAtPath(afterSnapshot, valuePath)
    };
  });
}
