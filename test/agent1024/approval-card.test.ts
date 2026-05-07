import { describe, expect, it } from "vitest";

import {
  buildAgent1024ApprovalCard,
  serializeAgent1024Card
} from "../../src/agent1024/approval-card.js";
import type { MutationPlan } from "../../src/core/intent-types.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "../../src/core/snapshot-normalizer.js";

function buildPlan(): MutationPlan {
  const beforeSnapshot = {
    status: "1"
  };

  return {
    planId: "plan-1",
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
    fieldSchemaHash: "schema-hash",
    requestedBy: "alice",
    approvalPrincipal: "wm:conv-1:alice",
    createdAtMs: 100,
    expiresAtMs: 1000,
    idempotencyKey: "idem-plan-1"
  };
}

describe("agent1024 approval card", () => {
  it("builds commonAction card with confirm and cancel REQUEST actions", () => {
    const card = buildAgent1024ApprovalCard({
      payload: {
        event: "PRE_TOOL_USE",
        paas: "wm",
        conversationId: "conv-1",
        userMis: "alice",
        toolName: "bash_execute",
        toolArguments: {
          command: "wm-merchant product set-status merchant-1 product-1 --status 0"
        }
      },
      plan: buildPlan(),
      options: {
        callbackUrl:
          "http://localhost:8080/webhook/safe-mutation/user-message-received",
        method: "POST"
      }
    });

    expect(card).toEqual(
      expect.objectContaining({
        cardType: "commonAction",
        cardContent: expect.objectContaining({
          submitId: "plan-1",
          intent: 1,
          text: expect.stringContaining("请确认你执行计划 `plan-1`"),
          positiveAction: {
            label: "确认执行",
            type: "REQUEST",
            data: {
              url: "http://localhost:8080/webhook/safe-mutation/user-message-received",
              method: "POST",
              params: expect.objectContaining({
                event: "USER_MESSAGE_RECEIVED",
                paas: "wm",
                conversationId: "conv-1",
                userMis: "alice",
                messageContent: "确认 plan-1"
              })
            }
          },
          negativeAction: {
            label: "取消执行",
            type: "REQUEST",
            data: {
              url: "http://localhost:8080/webhook/safe-mutation/user-message-received",
              method: "POST",
              params: expect.objectContaining({
                event: "USER_MESSAGE_RECEIVED",
                messageContent: "取消 plan-1"
              })
            }
          }
        })
      })
    );
  });

  it("serializes cards using the 1024 card wrapper syntax", () => {
    const card = buildAgent1024ApprovalCard({
      payload: {
        event: "PRE_TOOL_USE",
        paas: "wm",
        conversationId: "conv-1",
        userMis: "alice",
        toolName: "bash_execute",
        toolArguments: {}
      },
      plan: buildPlan(),
      options: {
        callbackUrl: "http://localhost/callback",
        method: "GET"
      }
    });

    const serialized = serializeAgent1024Card(card);

    expect(serialized).toMatch(/^:::\{"cardType":"commonAction"/u);
    expect(serialized).toMatch(/:::$/u);
    expect(serialized).toContain('"method":"GET"');
    expect(serialized).toContain('"label":"确认执行"');
  });
});
