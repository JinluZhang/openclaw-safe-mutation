import { describe, expect, it } from "vitest";

import type { ReadAdapter } from "../../src/adapters/read-adapter.js";
import { hashFieldSchema } from "../../src/field-schema.js";
import { ensureProtectedWritePlan } from "../../src/protected-write-plan.js";
import {
  shopBeforeSnapshot,
  shopFieldSchema
} from "../helpers/generic-schema.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";

const renamedShopPayload = {
  ...shopBeforeSnapshot,
  shop: {
    name: "New Shop"
  }
} satisfies Record<string, unknown>;

const renamedShopPayloadWithUnknownChange = {
  ...renamedShopPayload,
  internal_only: "unexpected"
} satisfies Record<string, unknown>;

const disabledShopPayload = {
  ...shopBeforeSnapshot,
  enabled: false
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
  it("creates a pending plan from a generic inline schema and freezes it", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const schemaHash = hashFieldSchema(shopFieldSchema);

    const result = await ensureProtectedWritePlan(
      {
        planStore,
        readAdapter: new FakeReadAdapter(shopBeforeSnapshot),
        now: () => 100,
        planIdFactory: () => "plan-protected-write"
      },
      {
        storeId: "store-1",
        writePayload: renamedShopPayload,
        fieldSchema: shopFieldSchema,
        fieldSchemaHash: schemaHash,
        requestedBy: "ou_user_1",
        sessionKey: "session-1",
        channel: "feishu"
      }
    );

    expect(result.created).toBe(true);
    expect(result.plan.planId).toBe("plan-protected-write");
    expect(result.plan.status).toBe("pending_ack");
    expect(result.plan.fieldSchemaSnapshot).toEqual(shopFieldSchema);
    expect(result.plan.fieldSchemaHash).toBe(schemaHash);
    expect(result.plan.diffItems).toEqual([
      expect.objectContaining({
        fieldId: "shop_name",
        label: "门店名称",
        before: "Old Shop",
        after: "New Shop"
      })
    ]);
  });

  it("reuses the same active plan when the intercepted payload is identical", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const dependencies = {
      planStore,
      readAdapter: new FakeReadAdapter(shopBeforeSnapshot),
      now: () => 200,
      planIdFactory: () => "plan-same-payload"
    };

    const first = await ensureProtectedWritePlan(dependencies, {
      storeId: "store-1",
      writePayload: renamedShopPayload,
      fieldSchema: shopFieldSchema,
      requestedBy: "ou_user_1"
    });
    const second = await ensureProtectedWritePlan(dependencies, {
      storeId: "store-1",
      writePayload: renamedShopPayload,
      fieldSchema: shopFieldSchema,
      requestedBy: "ou_user_1"
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
      readAdapter: new FakeReadAdapter(shopBeforeSnapshot),
      now: () => 300,
      planIdFactory: () => "plan-existing"
    };

    await ensureProtectedWritePlan(dependencies, {
      storeId: "store-1",
      writePayload: renamedShopPayload,
      fieldSchema: shopFieldSchema,
      requestedBy: "ou_user_1"
    });

    const result = await ensureProtectedWritePlan(
      {
        ...dependencies,
        planIdFactory: () => "plan-should-not-be-created"
      },
      {
        storeId: "store-1",
        writePayload: disabledShopPayload,
        fieldSchema: shopFieldSchema,
        requestedBy: "ou_user_1"
      }
    );

    expect(result.created).toBe(false);
    expect(result.blockedByOtherActivePlan).toBe(true);
    expect(result.plan.planId).toBe("plan-existing");
  });

  it("fails closed when a direct payload changes a field outside the schema", async () => {
    await expect(
      ensureProtectedWritePlan(
        {
          planStore: new InMemoryMutationPlanStore(),
          readAdapter: new FakeReadAdapter(shopBeforeSnapshot),
          now: () => 400,
          planIdFactory: () => "plan-unknown-field"
        },
        {
          storeId: "store-1",
          writePayload: renamedShopPayloadWithUnknownChange,
          fieldSchema: shopFieldSchema,
          requestedBy: "ou_user_1"
        }
      )
    ).rejects.toThrow(
      "Protected write payload changes unknown schema field at path internal_only."
    );
  });
});
