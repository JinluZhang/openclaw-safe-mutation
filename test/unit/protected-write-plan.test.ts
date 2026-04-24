import { describe, expect, it } from "vitest";

import type { ReadAdapter } from "../../src/adapters/read-adapter.js";
import { ensureProtectedWritePlan } from "../../src/protected-write-plan.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";

const beforeSnapshot = {
  activity_name: "weekday_lunch_full_reduction",
  activity_status: "enabled",
  start_time: "2026-04-21T10:00",
  end_time: "2026-05-21T22:00",
  weekday_mask: "1111100",
  min_order_price: 18,
  delivery_fee_discount: 2,
  tier_1_threshold: 25,
  tier_1_discount: 15,
  tier_2_threshold: 40,
  tier_2_discount: 20,
  tier_3_threshold: 60,
  tier_3_discount: 30,
  stack_with_coupon: true,
  stack_with_membership: false,
  new_customer_only: false,
  vip_only: false,
  budget_limit: 1200,
  remark: "seeded_for_safe_mutation_tests",
  promotion: {
    full_reduction_tiers: [
      { threshold: 25, reduction: 15 },
      { threshold: 40, reduction: 20 },
      { threshold: 60, reduction: 30 }
    ]
  }
} satisfies Record<string, unknown>;

const activityNameAfterSnapshot = {
  ...beforeSnapshot,
  activity_name: "weekday_lunch_flash_sale"
} satisfies Record<string, unknown>;

const fullReductionAfterSnapshot = {
  ...beforeSnapshot,
  tier_1_threshold: 20,
  promotion: {
    full_reduction_tiers: [
      { threshold: 20, reduction: 15 },
      { threshold: 40, reduction: 20 },
      { threshold: 60, reduction: 30 }
    ]
  }
} satisfies Record<string, unknown>;

class FakeReadAdapter implements ReadAdapter {
  constructor(private readonly snapshot: Record<string, unknown>) {}

  async readCurrentConfig(_params: {
    storeId: string;
  }): Promise<Record<string, unknown>> {
    return structuredClone(this.snapshot);
  }
}

describe("ensureProtectedWritePlan", () => {
  it("creates a pending plan directly from a protected write payload", async () => {
    const planStore = new InMemoryMutationPlanStore();

    const result = await ensureProtectedWritePlan(
      {
        planStore,
        readAdapter: new FakeReadAdapter(beforeSnapshot),
        now: () => 100,
        planIdFactory: () => "plan-protected-write"
      },
      {
        storeId: "store-1",
        writePayload: activityNameAfterSnapshot,
        requestedBy: "ou_user_1",
        sessionKey: "session-1",
        channel: "feishu"
      }
    );

    expect(result.created).toBe(true);
    expect(result.reusedExisting).toBe(false);
    expect(result.blockedByOtherActivePlan).toBe(false);
    expect(result.plan.planId).toBe("plan-protected-write");
    expect(result.plan.status).toBe("pending_ack");
    expect(result.plan.requestedBy).toBe("ou_user_1");
    expect(result.plan.channel).toBe("feishu");
    expect(result.plan.diffItems).toEqual([
      expect.objectContaining({
        fieldId: "activity_name",
        before: "weekday_lunch_full_reduction",
        after: "weekday_lunch_flash_sale"
      })
    ]);
  });

  it("reuses the same active plan when the intercepted payload is identical", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const dependencies = {
      planStore,
      readAdapter: new FakeReadAdapter(beforeSnapshot),
      now: () => 200,
      planIdFactory: () => "plan-same-payload"
    };

    const first = await ensureProtectedWritePlan(dependencies, {
      storeId: "store-1",
      writePayload: activityNameAfterSnapshot,
      requestedBy: "ou_user_1",
      sessionKey: "session-1",
      channel: "feishu"
    });
    const second = await ensureProtectedWritePlan(dependencies, {
      storeId: "store-1",
      writePayload: activityNameAfterSnapshot,
      requestedBy: "ou_user_1",
      sessionKey: "session-1",
      channel: "feishu"
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reusedExisting).toBe(true);
    expect(second.plan.planId).toBe("plan-same-payload");
  });

  it("surfaces the existing active plan when a different write is already pending", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const dependencies = {
      planStore,
      readAdapter: new FakeReadAdapter(beforeSnapshot),
      now: () => 300,
      planIdFactory: () => "plan-existing"
    };

    await ensureProtectedWritePlan(dependencies, {
      storeId: "store-1",
      writePayload: activityNameAfterSnapshot,
      requestedBy: "ou_user_1",
      sessionKey: "session-1",
      channel: "feishu"
    });

    const result = await ensureProtectedWritePlan(
      {
        ...dependencies,
        planIdFactory: () => "plan-should-not-be-created"
      },
      {
        storeId: "store-1",
        writePayload: fullReductionAfterSnapshot,
        requestedBy: "ou_user_1",
        sessionKey: "session-1",
        channel: "feishu"
      }
    );

    expect(result.created).toBe(false);
    expect(result.reusedExisting).toBe(false);
    expect(result.blockedByOtherActivePlan).toBe(true);
    expect(result.plan.planId).toBe("plan-existing");
  });
});
