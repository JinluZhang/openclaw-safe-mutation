import { randomUUID } from "node:crypto";

import {
  FULL_REDUCTION_TIER_SCALAR_FIELD_IDS,
  parameterCatalog
} from "./catalog.js";
import type { ReadAdapter } from "./adapters/read-adapter.js";
import { buildDiffItems } from "./diff.js";
import type {
  MutationExecutionContext,
  MutationPlan,
  ResolvedPatch
} from "./intent-types.js";
import { getValueAtPath } from "./object-path.js";
import type { MutationPlanStore } from "./plan-store.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "./snapshot-normalizer.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeComparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeComparable(item));
  }

  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const child = value[key];

      if (child !== undefined) {
        normalized[key] = normalizeComparable(child);
      }
    }

    return normalized;
  }

  return value;
}

function valuesExactlyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparable(left)) === JSON.stringify(normalizeComparable(right));
}

function renderInterpretationText(resolvedPatch: ResolvedPatch): string {
  const labels = resolvedPatch.fieldChanges.map((fieldChange) => {
    const catalogItem = parameterCatalog.find(
      (item) => item.fieldId === fieldChange.fieldId
    );

    return catalogItem
      ? `${catalogItem.labels[0]}(${fieldChange.fieldId})`
      : fieldChange.fieldId;
  });

  return `修改字段「${labels.join("、")}」`;
}

function buildResolvedPatchFromWritePayload(
  storeId: string,
  beforeSnapshot: Record<string, unknown>,
  writePayload: Record<string, unknown>
): ResolvedPatch {
  const changedFieldIds = new Set<string>();

  for (const catalogItem of parameterCatalog) {
    const beforeValue = getValueAtPath(beforeSnapshot, catalogItem.apiPath);
    const afterValue = getValueAtPath(writePayload, catalogItem.apiPath);

    if (valuesExactlyEqual(beforeValue, afterValue)) {
      continue;
    }

    if (afterValue === undefined) {
      throw new Error(
        `Protected write payload is missing required field ${catalogItem.fieldId}.`
      );
    }

    changedFieldIds.add(catalogItem.fieldId);
  }

  if (changedFieldIds.has("full_reduction_tiers")) {
    for (const fieldId of FULL_REDUCTION_TIER_SCALAR_FIELD_IDS) {
      changedFieldIds.delete(fieldId);
    }
  }

  const fieldChanges = parameterCatalog
    .filter((catalogItem) => changedFieldIds.has(catalogItem.fieldId))
    .map((catalogItem) => {
      const normalizedInput = getValueAtPath(writePayload, catalogItem.apiPath);

      if (normalizedInput === undefined) {
        throw new Error(
          `Protected write payload is missing required field ${catalogItem.fieldId}.`
        );
      }

      return {
        fieldId: catalogItem.fieldId,
        operation: catalogItem.supportsOperations[0]!,
        normalizedInput: structuredClone(normalizedInput)
      };
    });

  if (fieldChanges.length === 0) {
    throw new Error("Protected write payload does not change any known fields.");
  }

  return {
    kind: "mutation.resolved.patch",
    storeId,
    fieldChanges
  };
}

function buildPayloadHash(payload: Record<string, unknown>): string {
  return hashNormalizedSnapshot(normalizeSnapshot(payload));
}

function buildGeneratedUserText(storeId: string, resolvedPatch: ResolvedPatch): string {
  const labels = resolvedPatch.fieldChanges.map((fieldChange) => {
    const catalogItem = parameterCatalog.find(
      (item) => item.fieldId === fieldChange.fieldId
    );

    return catalogItem?.labels[0] ?? fieldChange.fieldId;
  });

  return `通过受保护写工具申请修改门店 ${storeId} 的 ${labels.join("、")}`;
}

export interface EnsureProtectedWritePlanDependencies {
  planStore: MutationPlanStore;
  readAdapter: ReadAdapter;
  now?: () => number;
  planIdFactory?: () => string;
  planTtlMs?: number;
}

export interface EnsureProtectedWritePlanInput {
  storeId: string;
  writePayload: Record<string, unknown>;
  beforeSnapshot?: Record<string, unknown>;
  executionContext?: MutationExecutionContext;
  requestedBy: string;
  approvalChannel?: string;
  approvalSenderId?: string;
  approvalAccountId?: string;
  approvalPrincipal?: string;
  sessionKey?: string;
  channel?: string;
}

export interface EnsureProtectedWritePlanResult {
  plan: MutationPlan;
  created: boolean;
  reusedExisting: boolean;
  blockedByOtherActivePlan: boolean;
}

export async function ensureProtectedWritePlan(
  dependencies: EnsureProtectedWritePlanDependencies,
  input: EnsureProtectedWritePlanInput
): Promise<EnsureProtectedWritePlanResult> {
  const now = dependencies.now ?? Date.now;
  const planIdFactory =
    dependencies.planIdFactory ?? (() => `plan_${randomUUID()}`);
  const planTtlMs = dependencies.planTtlMs ?? 15 * 60 * 1000;
  const nowMs = now();

  for (const activePlan of await dependencies.planStore.listActiveByStore(
    input.storeId
  )) {
    if (activePlan.expiresAtMs <= nowMs) {
      activePlan.status = "expired";
      activePlan.finishedAtMs ??= nowMs;
      await dependencies.planStore.update(activePlan);
    }
  }

  const remainingActivePlans = await dependencies.planStore.listActiveByStore(
    input.storeId
  );
  const requestedPayloadHash = buildPayloadHash(input.writePayload);

  for (const activePlan of remainingActivePlans) {
    const activePayloadHash = buildPayloadHash(activePlan.writePayload);

    if (activePayloadHash === requestedPayloadHash) {
      return {
        plan: activePlan,
        created: false,
        reusedExisting: true,
        blockedByOtherActivePlan: false
      };
    }
  }

  if (remainingActivePlans.length > 0) {
    return {
      plan: remainingActivePlans[0]!,
      created: false,
      reusedExisting: false,
      blockedByOtherActivePlan: true
    };
  }

  const beforeSnapshot =
    input.beforeSnapshot ??
    (await dependencies.readAdapter.readCurrentConfig({
      storeId: input.storeId,
      executionContext: input.executionContext
    }));
  const resolvedPatch = buildResolvedPatchFromWritePayload(
    input.storeId,
    beforeSnapshot,
    input.writePayload
  );
  const plan: MutationPlan = {
    planId: planIdFactory(),
    mutationKind: `protected_write.${resolvedPatch.fieldChanges
      .map((fieldChange) => fieldChange.fieldId)
      .join("+")}`,
    status: "pending_ack",
    storeId: input.storeId,
    userText: buildGeneratedUserText(input.storeId, resolvedPatch),
    interpretationText: renderInterpretationText(resolvedPatch),
    beforeSnapshot,
    beforeHash: hashNormalizedSnapshot(normalizeSnapshot(beforeSnapshot)),
    resolvedPatch,
    writePayload: structuredClone(input.writePayload),
    diffItems: buildDiffItems(beforeSnapshot, input.writePayload, resolvedPatch),
    requestedBy: input.requestedBy,
    approvalChannel: input.approvalChannel,
    approvalSenderId: input.approvalSenderId,
    approvalAccountId: input.approvalAccountId,
    approvalPrincipal: input.approvalPrincipal,
    executionContext: input.executionContext,
    sessionKey: input.sessionKey,
    channel: input.channel,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + planTtlMs,
    idempotencyKey: `idem_${randomUUID()}`
  };

  await dependencies.planStore.create(plan);

  return {
    plan,
    created: true,
    reusedExisting: false,
    blockedByOtherActivePlan: false
  };
}
