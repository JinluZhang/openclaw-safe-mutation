import { describe, expect, it } from "vitest";

import { renderMutationPlanForText } from "../../src/channels/text-render.js";
import type { MutationPlan } from "../../src/intent-types.js";
import { parseTextPlanAction } from "../../src/text-plan-actions.js";

const pendingPlan: MutationPlan = {
  planId: "plan_123",
  mutationKind: "protected_write.full_reduction_tiers",
  status: "pending_ack",
  storeId: "store-1",
  userText: "通过受保护写工具申请修改门店 store-1 的 满减档位",
  interpretationText: "修改字段「满减档位(full_reduction_tiers)」",
  beforeSnapshot: {
    promotion: {
      full_reduction_tiers: [
        { threshold: 25, reduction: 15 },
        { threshold: 40, reduction: 20 }
      ]
    }
  },
  beforeHash: "hash",
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
  diffItems: [
    {
      fieldId: "full_reduction_tiers",
      label: "满减档位",
      before: [
        { threshold: 25, reduction: 15 },
        { threshold: 40, reduction: 20 }
      ],
      after: [
        { threshold: 20, reduction: 15 },
        { threshold: 40, reduction: 20 }
      ]
    }
  ],
  requestedBy: "alice",
  sessionKey: "session-1",
  channel: "feishu",
  createdAtMs: 1,
  expiresAtMs: 1000,
  idempotencyKey: "idem-1"
};

describe("text plan actions", () => {
  it("parses approval and cancellation replies without slash commands", () => {
    expect(parseTextPlanAction("确认")).toEqual({
      kind: "approve"
    });
    expect(parseTextPlanAction("确认 plan_123")).toEqual({
      kind: "approve",
      planId: "plan_123"
    });
    expect(parseTextPlanAction("确认plan_123")).toEqual({
      kind: "approve",
      planId: "plan_123"
    });
    expect(parseTextPlanAction("取消 plan_123")).toEqual({
      kind: "cancel",
      planId: "plan_123"
    });
    expect(parseTextPlanAction("取消plan_123")).toEqual({
      kind: "cancel",
      planId: "plan_123"
    });
  });

  it("ignores legacy slash commands and free-form chatter", () => {
    expect(parseTextPlanAction("/mutate-approve plan_123")).toBeUndefined();
    expect(parseTextPlanAction("确认一下这个方案")).toBeUndefined();
  });

  it("renders plain-text confirmation guidance", () => {
    const rendered = renderMutationPlanForText(pendingPlan);

    expect(rendered).toContain('确认方式：回复“确认”后由系统直接执行');
    expect(rendered).toContain('取消方式：回复“取消”放弃本次变更');
    expect(rendered).not.toContain("/mutate-approve");
    expect(rendered).not.toContain("/mutate-cancel");
  });
});
