import type { MutationPlanStore } from "../../core/plan-store.js";
import type {
  ProtectedWriteRequestResolution
} from "../../core/protected-write-request.js";
import { resolveProtectedWriteRequest } from "../../core/protected-write-request.js";
import {
  defaultProtectedMutationRegistry,
  type ProtectedMutationRegistry
} from "../../core/mutation-registry.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "../../core/snapshot-normalizer.js";

export interface BeforeToolCallInput {
  toolName: string;
  params: Record<string, unknown>;
  approvedPlanId?: string;
  actor?: string;
  storeId?: string;
}

export interface BeforeToolCallDependencies {
  planStore: Pick<MutationPlanStore, "get">;
  protectedMutationRegistry?: ProtectedMutationRegistry;
  resolveProtectedWriteRequest?: (input: {
    toolName: string;
    params: Record<string, unknown>;
    registry?: ProtectedMutationRegistry;
  }) => Promise<ProtectedWriteRequestResolution | undefined>;
  now?: () => number;
}

export interface BeforeToolCallDecision {
  action: "allow" | "block";
  reason?: string;
  protectedWriteRequest?: ProtectedWriteRequestResolution["request"];
}

function block(
  reason: string,
  protectedWriteRequest?: ProtectedWriteRequestResolution["request"]
): BeforeToolCallDecision {
  return {
    action: "block",
    reason,
    protectedWriteRequest
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordsExactlyEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return (
    hashNormalizedSnapshot(normalizeSnapshot(left)) ===
    hashNormalizedSnapshot(normalizeSnapshot(right))
  );
}

export async function guardBeforeToolCall(
  dependencies: BeforeToolCallDependencies,
  input: BeforeToolCallInput
): Promise<BeforeToolCallDecision> {
  const registry =
    dependencies.protectedMutationRegistry ?? defaultProtectedMutationRegistry;
  const protectedWriteResolution = await (
    dependencies.resolveProtectedWriteRequest ?? resolveProtectedWriteRequest
  )({
    toolName: input.toolName,
    params: input.params,
    registry
  });

  if (protectedWriteResolution?.error) {
    return block(protectedWriteResolution.error);
  }

  const protectedWriteRequest = protectedWriteResolution?.request;

  if (!protectedWriteRequest && registry.isProtectedToolName(input.toolName)) {
    return block(
      "Protected write tool has no matching mutation binding or read configuration."
    );
  }

  const effectiveToolName = protectedWriteRequest?.toolName ?? input.toolName;
  const isProtectedTool =
    Boolean(protectedWriteRequest) || registry.isProtectedToolName(effectiveToolName);

  if (!isProtectedTool) {
    return {
      action: "allow"
    };
  }

  const approvedPlanId =
    input.approvedPlanId ??
    protectedWriteRequest?.approvedPlanId ??
    getString(input.params.approvedPlanId);

  if (!approvedPlanId) {
    return block(
      "This write path requires an approved mutation plan.",
      protectedWriteRequest
    );
  }

  const plan = await dependencies.planStore.get(approvedPlanId);

  if (!plan || plan.status !== "approved") {
    return block(
      "Approved mutation plan not found or not in approved state.",
      protectedWriteRequest
    );
  }

  if (plan.expiresAtMs <= (dependencies.now ?? Date.now)()) {
    return block("The approved mutation plan has expired.", protectedWriteRequest);
  }

  const requestStoreId =
    protectedWriteRequest?.storeId ??
    input.storeId ??
    getString(input.params.storeId);

  if (requestStoreId !== plan.storeId) {
    return block("Store does not match the approved mutation plan.", protectedWriteRequest);
  }

  const sanitizedParams = protectedWriteRequest
    ? {
        storeId: protectedWriteRequest.storeId,
        payload: protectedWriteRequest.payload
      }
    : structuredClone(input.params);

  if (!protectedWriteRequest) {
    delete sanitizedParams.approvedPlanId;
  }

  if (
    !recordsExactlyEqual(sanitizedParams, {
      storeId: plan.storeId,
      payload: plan.writePayload
    })
  ) {
    return block(
      "Write payload does not match the approved frozen plan.",
      protectedWriteRequest
    );
  }

  return {
    action: "allow"
  };
}
