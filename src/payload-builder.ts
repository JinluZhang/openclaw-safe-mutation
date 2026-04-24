import {
  FULL_REDUCTION_TIER_SCALAR_FIELD_IDS,
  type ParameterCatalog
} from "./catalog.js";
import type { ResolvedPatch } from "./intent-types.js";
import { getValueAtPath, setValueAtPath } from "./object-path.js";

interface FullReductionTier {
  threshold: number;
  reduction: number;
}

const FULL_REDUCTION_TIER_SCALAR_GROUPS = [
  {
    thresholdFieldId: "tier_1_threshold",
    discountFieldId: "tier_1_discount"
  },
  {
    thresholdFieldId: "tier_2_threshold",
    discountFieldId: "tier_2_discount"
  },
  {
    thresholdFieldId: "tier_3_threshold",
    discountFieldId: "tier_3_discount"
  }
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneTierList(tiers: readonly FullReductionTier[]): FullReductionTier[] {
  return tiers.map((tier) => ({
    threshold: tier.threshold,
    reduction: tier.reduction
  }));
}

function tryReadPromotionTierList(
  snapshot: Record<string, unknown>
): FullReductionTier[] | undefined {
  const value = getValueAtPath(snapshot, "promotion.full_reduction_tiers");

  if (!Array.isArray(value)) {
    return;
  }

  const tiers = value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const threshold = item.threshold;
    const reduction = item.reduction;

    if (typeof threshold !== "number" || typeof reduction !== "number") {
      return [];
    }

    return [
      {
        threshold,
        reduction
      }
    ];
  });

  return tiers.length === value.length ? tiers : undefined;
}

function hasAnyTierScalarField(snapshot: Record<string, unknown>): boolean {
  return FULL_REDUCTION_TIER_SCALAR_FIELD_IDS.some((fieldId) => fieldId in snapshot);
}

function buildTierListFromScalarFields(
  snapshot: Record<string, unknown>,
  fallback?: readonly FullReductionTier[]
): FullReductionTier[] | undefined {
  const tiers = FULL_REDUCTION_TIER_SCALAR_GROUPS.map((group, index) => {
    const thresholdValue = snapshot[group.thresholdFieldId];
    const discountValue = snapshot[group.discountFieldId];

    if (typeof thresholdValue === "number" && typeof discountValue === "number") {
      return {
        threshold: thresholdValue,
        reduction: discountValue
      };
    }

    return fallback?.[index];
  });

  return tiers.every(
    (tier): tier is FullReductionTier =>
      tier !== undefined &&
      typeof tier.threshold === "number" &&
      typeof tier.reduction === "number"
  )
    ? cloneTierList(tiers)
    : undefined;
}

function syncScalarFieldsFromTierList(
  snapshot: Record<string, unknown>,
  tiers: readonly FullReductionTier[]
): Record<string, unknown> {
  let nextSnapshot = snapshot;

  FULL_REDUCTION_TIER_SCALAR_GROUPS.forEach((group, index) => {
    const tier = tiers[index];

    if (!tier) {
      return;
    }

    const resolvedTier: FullReductionTier = tier;

    nextSnapshot = setValueAtPath(
      nextSnapshot,
      group.thresholdFieldId,
      resolvedTier.threshold
    );
    nextSnapshot = setValueAtPath(
      nextSnapshot,
      group.discountFieldId,
      resolvedTier.reduction
    );
  });

  return nextSnapshot;
}

function syncPromotionTierListFromScalars(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const currentTierList = tryReadPromotionTierList(snapshot);
  const nextTierList = buildTierListFromScalarFields(snapshot, currentTierList);

  if (!nextTierList) {
    return snapshot;
  }

  return setValueAtPath(snapshot, "promotion.full_reduction_tiers", nextTierList);
}

function synchronizeDerivedTierViews(
  snapshot: Record<string, unknown>,
  changedFieldIds: readonly string[]
): Record<string, unknown> {
  const changedFieldIdSet = new Set(changedFieldIds);
  const changedFullReductionTiers = changedFieldIdSet.has("full_reduction_tiers");
  const changedTierScalarFields = FULL_REDUCTION_TIER_SCALAR_FIELD_IDS.filter(
    (fieldId) => changedFieldIdSet.has(fieldId)
  );

  if (changedFullReductionTiers) {
    const currentTierList = tryReadPromotionTierList(snapshot);

    if (!currentTierList || !hasAnyTierScalarField(snapshot)) {
      return snapshot;
    }

    return syncScalarFieldsFromTierList(snapshot, currentTierList);
  }

  if (changedTierScalarFields.length > 0) {
    return syncPromotionTierListFromScalars(snapshot);
  }

  return snapshot;
}

export function buildWritePayload(
  currentSnapshot: Record<string, unknown>,
  resolvedPatch: ResolvedPatch,
  catalog: ParameterCatalog
): Record<string, unknown> {
  const catalogByFieldId = new Map(
    catalog.map((item) => [item.fieldId, item] as const)
  );

  let nextSnapshot = structuredClone(currentSnapshot);

  for (const fieldChange of resolvedPatch.fieldChanges) {
    const catalogItem = catalogByFieldId.get(fieldChange.fieldId);

    if (!catalogItem) {
      throw new Error(`Unknown field id in resolved patch: ${fieldChange.fieldId}`);
    }

    nextSnapshot = setValueAtPath(
      nextSnapshot,
      catalogItem.apiPath,
      fieldChange.normalizedInput
    );
  }

  return synchronizeDerivedTierViews(
    nextSnapshot,
    resolvedPatch.fieldChanges.map((fieldChange) => fieldChange.fieldId)
  );
}
