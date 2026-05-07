import { describe, expect, it } from "vitest";

import { Agent1024SqliteMutationPlanStore } from "../../src/agent1024/sqlite-plan-store.js";
import type { MutationPlan } from "../../src/core/intent-types.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "../../src/core/snapshot-normalizer.js";

function buildPlan(
  overrides: Partial<MutationPlan> & Pick<MutationPlan, "planId">
): MutationPlan {
  const { planId, ...rest } = overrides;
  const beforeSnapshot = {
    status: "1"
  };

  return {
    planId,
    mutationKind: "wm.product.status",
    status: "pending_ack",
    storeId: "wm-product-status:merchant-1:product-1",
    userText: "下架商品",
    interpretationText: "修改商品状态",
    beforeSnapshot,
    beforeHash: hashNormalizedSnapshot(normalizeSnapshot(beforeSnapshot)),
    resolvedPatch: {
      kind: "mutation.resolved.patch",
      storeId: "wm-product-status:merchant-1:product-1",
      fieldChanges: [
        {
          fieldId: "status",
          operation: "set",
          normalizedInput: "0"
        }
      ]
    },
    writePayload: {
      status: "0"
    },
    diffItems: [
      {
        fieldId: "status",
        label: "商品状态",
        before: "1",
        after: "0"
      }
    ],
    fieldSchemaSnapshot: [],
    fieldSchemaHash: "field-schema-hash",
    requestedBy: "alice",
    approvalPrincipal: "wm:conv-1:alice",
    approvalDeliveryStatus: "sent",
    createdAtMs: 100,
    expiresAtMs: 1000,
    idempotencyKey: `idem-${planId}`,
    ...rest
  };
}

describe("Agent1024SqliteMutationPlanStore", () => {
  it("creates, gets, and lists active plans by store", async () => {
    const store = new Agent1024SqliteMutationPlanStore();
    try {
      await store.create(buildPlan({ planId: "plan-1" }));
      await store.create(
        buildPlan({
          planId: "plan-2",
          status: "approved"
        })
      );
      await store.create(
        buildPlan({
          planId: "plan-3",
          status: "succeeded"
        })
      );
      await store.create(
        buildPlan({
          planId: "plan-other-store",
          storeId: "wm-product-status:merchant-2:product-2"
        })
      );

      await expect(store.get("plan-1")).resolves.toEqual(
        expect.objectContaining({
          planId: "plan-1",
          status: "pending_ack",
          version: 1
        })
      );

      const activePlans = await store.listActiveByStore(
        "wm-product-status:merchant-1:product-1"
      );

      expect(activePlans.map((plan) => plan.planId)).toEqual([
        "plan-1",
        "plan-2"
      ]);
    } finally {
      store.close();
    }
  });

  it("increments version after a successful pending_ack to approved transition", async () => {
    const store = new Agent1024SqliteMutationPlanStore();
    try {
      await store.create(buildPlan({ planId: "plan-1" }));

      const approvedPlan = await store.tryTransition(
        "plan-1",
        "pending_ack",
        "approved",
        {
          approvedBy: "alice",
          approvedAtMs: 200
        }
      );

      expect(approvedPlan).toEqual(
        expect.objectContaining({
          approvedAtMs: 200,
          approvedBy: "alice",
          status: "approved",
          version: 2
        })
      );
      await expect(store.get("plan-1")).resolves.toEqual(
        expect.objectContaining({
          status: "approved",
          version: 2
        })
      );
    } finally {
      store.close();
    }
  });

  it("returns undefined when the same fromStatus CAS is attempted twice", async () => {
    const store = new Agent1024SqliteMutationPlanStore();
    try {
      await store.create(buildPlan({ planId: "plan-1" }));

      await store.tryTransition("plan-1", "pending_ack", "approved");
      const secondTransition = await store.tryTransition(
        "plan-1",
        "pending_ack",
        "approved"
      );

      expect(secondTransition).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("does not allow terminal plans to transition back to active states", async () => {
    const store = new Agent1024SqliteMutationPlanStore();
    try {
      await store.create(buildPlan({ planId: "plan-1" }));
      await store.updateStatus("plan-1", "succeeded");

      await expect(store.updateStatus("plan-1", "approved")).rejects.toThrow(
        "Cannot transition terminal plan from succeeded to approved"
      );
      await expect(
        store.tryTransition("plan-1", "succeeded", "executing")
      ).rejects.toThrow(
        "Cannot transition terminal plan from succeeded to executing"
      );
    } finally {
      store.close();
    }
  });

  it("lists only pending_ack plans for the requested approval principal", async () => {
    const store = new Agent1024SqliteMutationPlanStore();
    try {
      await store.create(
        buildPlan({
          planId: "plan-1",
          approvalPrincipal: "wm:conv-1:alice"
        })
      );
      await store.create(
        buildPlan({
          planId: "plan-2",
          approvalPrincipal: "wm:conv-1:alice",
          status: "approved"
        })
      );
      await store.create(
        buildPlan({
          planId: "plan-3",
          approvalPrincipal: "wm:conv-1:bob"
        })
      );

      const pendingPlans = await store.listPendingByApprovalPrincipal(
        "wm:conv-1:alice"
      );

      expect(pendingPlans.map((plan) => plan.planId)).toEqual(["plan-1"]);
    } finally {
      store.close();
    }
  });
});
