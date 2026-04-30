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
    plan.status = "expired";
    plan.finishedAtMs ??= now();
    await dependencies.planStore.update(plan);
    return plan;
  }

  const currentSnapshot = await dependencies.readAdapter.readCurrentConfig({
    storeId: plan.storeId,
    executionContext: plan.executionContext
  });
  const currentHash = hashNormalizedSnapshot(normalizeSnapshot(currentSnapshot));

  if (currentHash !== plan.beforeHash) {
    plan.status = "conflict";
    plan.finishedAtMs = now();
    plan.result = {
      ...(plan.result ?? {}),
      error: "Current store config changed after approval"
    };
    await dependencies.planStore.update(plan);
    return plan;
  }

  plan.status = "executing";
  plan.executedAtMs ??= now();
  await dependencies.planStore.update(plan);

  try {
    const writeResult = await dependencies.writeAdapter.writeConfig({
      storeId: plan.storeId,
      payload: plan.writePayload,
      executionContext: plan.executionContext
    });
    const verifySnapshot = await dependencies.verifyAdapter.verifyCurrentConfig({
      storeId: plan.storeId,
      executionContext: plan.executionContext
    });
    const comparableVerifySnapshot = normalizeVerificationSnapshot({
      snapshot: verifySnapshot,
      executionContext: plan.executionContext
    });
    const comparableWritePayload = normalizeVerificationSnapshot({
      snapshot: plan.writePayload,
      executionContext: plan.executionContext
    });
    const verifySucceeded =
      hashNormalizedSnapshot(normalizeSnapshot(comparableVerifySnapshot)) ===
      hashNormalizedSnapshot(normalizeSnapshot(comparableWritePayload));

    plan.status = verifySucceeded ? "succeeded" : "failed";
    plan.finishedAtMs = now();
    plan.result = {
      writeSucceeded: writeResult.exitCode === 0,
      verifySucceeded,
      writeStdout: writeResult.stdout,
      writeStderr: writeResult.stderr,
      verifySnapshot,
      error: verifySucceeded ? undefined : "Post-write verification failed"
    };
    await dependencies.planStore.update(plan);
    return plan;
  } catch (error) {
    plan.status = "failed";
    plan.finishedAtMs = now();
    plan.result = {
      ...(plan.result ?? {}),
      error: error instanceof Error ? error.message : String(error)
    };
    await dependencies.planStore.update(plan);
    return plan;
  }
}
