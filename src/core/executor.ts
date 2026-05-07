import type { ReadAdapter } from "./adapters/read-adapter.js";
import type { VerifyAdapter } from "./adapters/verify-adapter.js";
import type { WriteAdapter } from "./adapters/write-adapter.js";
import type { MutationPlan } from "./intent-types.js";
import type { MutationPlanStore } from "./plan-store.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "./snapshot-normalizer.js";
import { normalizeVerificationSnapshot } from "./tool-backed-adapters.js";

export interface ExecuteMutationPlanDependencies {
  planStore: MutationPlanStore;
  readAdapter: ReadAdapter;
  writeAdapter: WriteAdapter;
  verifyAdapter: VerifyAdapter;
  now?: () => number;
}

export async function executeMutationPlan(
  dependencies: ExecuteMutationPlanDependencies,
  planId: string
): Promise<MutationPlan> {
  const now = dependencies.now ?? Date.now;
  const plan = await dependencies.planStore.get(planId);

  if (!plan) {
    throw new Error(`Plan ${planId} does not exist`);
  }

  if (
    plan.status === "succeeded" ||
    plan.status === "failed" ||
    plan.status === "conflict" ||
    plan.status === "cancelled" ||
    plan.status === "expired" ||
    plan.status === "executing"
  ) {
    return plan;
  }

  if (plan.status !== "approved") {
    throw new Error(`Plan ${planId} must be approved before execution`);
  }

  if (plan.expiresAtMs <= now()) {
    const expiredPlan = await dependencies.planStore.tryTransition(
      plan.planId,
      "approved",
      "expired",
      {
        finishedAtMs: plan.finishedAtMs ?? now()
      }
    );
    return expiredPlan ?? (await dependencies.planStore.get(plan.planId)) ?? plan;
  }

  const executingPlan = await dependencies.planStore.tryTransition(
    plan.planId,
    "approved",
    "executing",
    {
      executedAtMs: plan.executedAtMs ?? now()
    }
  );

  if (!executingPlan) {
    return (await dependencies.planStore.get(plan.planId)) ?? plan;
  }

  let currentSnapshot: Record<string, unknown>;

  try {
    currentSnapshot = await dependencies.readAdapter.readCurrentConfig({
      storeId: executingPlan.storeId,
      executionContext: executingPlan.executionContext
    });
  } catch (error) {
    executingPlan.status = "failed";
    executingPlan.finishedAtMs = now();
    executingPlan.result = {
      ...(executingPlan.result ?? {}),
      error: error instanceof Error ? error.message : String(error)
    };
    await dependencies.planStore.update(executingPlan);
    return executingPlan;
  }

  const currentHash = hashNormalizedSnapshot(normalizeSnapshot(currentSnapshot));

  if (currentHash !== executingPlan.beforeHash) {
    executingPlan.status = "conflict";
    executingPlan.finishedAtMs = now();
    executingPlan.result = {
      ...(executingPlan.result ?? {}),
      error: "Current store config changed after approval"
    };
    await dependencies.planStore.update(executingPlan);
    return executingPlan;
  }

  try {
    const writeResult = await dependencies.writeAdapter.writeConfig({
      storeId: executingPlan.storeId,
      payload: executingPlan.writePayload,
      executionContext: executingPlan.executionContext
    });
    const verifySnapshot = await dependencies.verifyAdapter.verifyCurrentConfig({
      storeId: executingPlan.storeId,
      executionContext: executingPlan.executionContext
    });
    const comparableVerifySnapshot = normalizeVerificationSnapshot({
      snapshot: verifySnapshot,
      executionContext: executingPlan.executionContext
    });
    const comparableWritePayload = normalizeVerificationSnapshot({
      snapshot: executingPlan.writePayload,
      executionContext: executingPlan.executionContext
    });
    const verifySucceeded =
      hashNormalizedSnapshot(normalizeSnapshot(comparableVerifySnapshot)) ===
      hashNormalizedSnapshot(normalizeSnapshot(comparableWritePayload));

    executingPlan.status = verifySucceeded ? "succeeded" : "failed";
    executingPlan.finishedAtMs = now();
    executingPlan.result = {
      writeSucceeded: writeResult.exitCode === 0,
      verifySucceeded,
      writeStdout: writeResult.stdout,
      writeStderr: writeResult.stderr,
      verifySnapshot,
      error: verifySucceeded ? undefined : "Post-write verification failed"
    };
    await dependencies.planStore.update(executingPlan);
    return executingPlan;
  } catch (error) {
    executingPlan.status = "failed";
    executingPlan.finishedAtMs = now();
    executingPlan.result = {
      ...(executingPlan.result ?? {}),
      error: error instanceof Error ? error.message : String(error)
    };
    await dependencies.planStore.update(executingPlan);
    return executingPlan;
  }
}
