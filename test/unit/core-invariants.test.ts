import { describe, expect, it } from "vitest";

import {
  ACTIVE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  type MutationPlan
} from "../../src/intent-types.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "../../src/snapshot-normalizer.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";
import { shopFieldSchema } from "../helpers/generic-schema.js";

const baseSnapshot = {
  promotion: {
    full_reduction_tiers: [
      { threshold: 25, reduction: 15 },
      { threshold: 40, reduction: 20 }
    ]
  }
} satisfies Record<string, unknown>;

function buildPlan(status: MutationPlan["status"]): MutationPlan {
  return {
    planId: "plan-1",
    mutationKind: "promotion.full_reduction_tiers",
    status,
    storeId: "store-1",
    userText: "把满减从 25-15 改成 20-15",
    interpretationText: "修改字段「满减档位(full_reduction_tiers)」",
    beforeSnapshot: baseSnapshot,
    beforeHash: hashNormalizedSnapshot(normalizeSnapshot(baseSnapshot)),
    resolvedPatch: {
      kind: "mutation.resolved.patch",
      storeId: "store-1",
      fieldChanges: [
        {
          fieldId: "full_reduction_tiers",
          operation: "replace_item",
          normalizedInput: [
            { threshold: 20, reduction: 15 },
            { threshold: 40, reduction: 20 }
          ]
        }
      ]
    },
    writePayload: {
      promotion: {
        full_reduction_tiers: [
          { threshold: 20, reduction: 15 },
          { threshold: 40, reduction: 20 }
        ]
      }
    },
    diffItems: [],
    fieldSchemaSnapshot: shopFieldSchema,
    fieldSchemaHash: "schema-hash",
    requestedBy: "alice",
    createdAtMs: 1,
    expiresAtMs: 1000,
    idempotencyKey: "idem-1"
  };
}

describe("core invariants", () => {
  it("exposes the active plan states expected by the design", () => {
    expect(ACTIVE_PLAN_STATUSES).toEqual([
      "pending_ack",
      "approved",
      "executing"
    ]);
  });

  it("keeps writable fields scoped to a protected mutation schema", () => {
    expect(shopFieldSchema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldId: "shop_name",
          readPath: "shop.name",
          valueType: "string"
        })
      ])
    );
  });

  it("keeps terminal plan states explicit", () => {
    expect(TERMINAL_PLAN_STATUSES).toContain("conflict");
  });

  it("computes the same hash for semantically identical snapshots", () => {
    const left = {
      promotion: {
        full_reduction_tiers: [
          { threshold: 25, reduction: 15 },
          { threshold: 40, reduction: 20 }
        ]
      },
      metadata: {
        enabled: true,
        label: "promo"
      }
    };
    const right = {
      metadata: {
        label: "promo",
        enabled: true
      },
      promotion: {
        full_reduction_tiers: [
          { reduction: 15, threshold: 25 },
          { reduction: 20, threshold: 40 }
        ]
      }
    };

    expect(hashNormalizedSnapshot(normalizeSnapshot(left))).toBe(
      hashNormalizedSnapshot(normalizeSnapshot(right))
    );
  });

  it("does not allow terminal plans to transition back to an active state", async () => {
    const store = new InMemoryMutationPlanStore();
    await store.create(buildPlan("pending_ack"));
    await store.updateStatus("plan-1", "succeeded");

    await expect(store.updateStatus("plan-1", "approved")).rejects.toThrow(
      "Cannot transition terminal plan from succeeded to approved"
    );
  });

  it("lists pending plans scoped to an approval principal", async () => {
    const store = new InMemoryMutationPlanStore();
    await store.create({
      ...buildPlan("pending_ack"),
      approvalPrincipal: "feishu:default:alice"
    });
    await store.create({
      ...buildPlan("approved"),
      planId: "plan-2",
      approvalPrincipal: "feishu:default:alice"
    });
    await store.create({
      ...buildPlan("pending_ack"),
      planId: "plan-3",
      approvalPrincipal: "feishu:default:bob"
    });

    const plans = await store.listPendingByApprovalPrincipal(
      "feishu:default:alice"
    );

    expect(plans.map((plan) => plan.planId)).toEqual(["plan-1"]);
  });

  it("transitions plan status with compare-and-swap semantics", async () => {
    const store = new InMemoryMutationPlanStore();
    await store.create(buildPlan("approved"));

    const firstTransition = await store.tryTransition(
      "plan-1",
      "approved",
      "executing",
      {
        executedAtMs: 2
      }
    );
    const secondTransition = await store.tryTransition(
      "plan-1",
      "approved",
      "executing"
    );

    expect(firstTransition).toEqual(
      expect.objectContaining({
        status: "executing",
        executedAtMs: 2,
        version: 2
      })
    );
    expect(secondTransition).toBeUndefined();
    await store.updateStatus("plan-1", "succeeded");
    await expect(
      store.tryTransition("plan-1", "succeeded", "approved")
    ).rejects.toThrow(
      "Cannot transition terminal plan from succeeded to approved"
    );
  });
});
