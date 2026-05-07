import { describe, expect, it } from "vitest";

import { buildSafeMutationContext } from "../../src/agent1024/safe-mutation-context.js";
import type { MutationPlan } from "../../src/core/intent-types.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "../../src/core/snapshot-normalizer.js";

function buildPlan(overrides: Partial<MutationPlan>): MutationPlan {
  const beforeSnapshot = {
    status: "1"
  };

  return {
    planId: "plan-1",
    mutationKind: "wm.product.status",
    status: "succeeded",
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
    diffItems: [],
    fieldSchemaSnapshot: [],
    fieldSchemaHash: "schema-hash",
    requestedBy: "alice",
    createdAtMs: 100,
    expiresAtMs: 1000,
    idempotencyKey: "idem-plan-1",
    executionContext: {
      kind: "configured_mutation",
      bindingId: "wm-product-set-status",
      protectedToolName: "bash",
      resourceId: "wm-product-status:merchant-1:product-1",
      readInvocation: {
        kind: "shell",
        command: "wm-merchant product get-status merchant-1 product-1"
      },
      writeInvocation: {
        kind: "shell",
        command:
          "wm-merchant product set-status merchant-1 product-1 --status 0"
      }
    },
    ...overrides
  };
}

describe("buildSafeMutationContext", () => {
  it("describes succeeded as executed and forbids repeating the write tool", () => {
    const context = buildSafeMutationContext({
      action: "approve",
      plan: buildPlan({
        status: "succeeded",
        result: {
          writeSucceeded: true,
          verifySucceeded: true,
          writeStdout: "ok",
          writeStderr: "",
          verifySnapshot: {
            status: "0"
          }
        }
      })
    });

    expect(context).toContain("状态：succeeded");
    expect(context).toContain("已执行冻结写操作");
    expect(context).toContain("验证结果：写入并回读验证成功");
    expect(context).toContain("不要重复调用同一写工具");
  });

  it("describes conflict as not executed due to pre-write drift", () => {
    const context = buildSafeMutationContext({
      action: "approve",
      plan: buildPlan({
        status: "conflict",
        result: {
          error: "Current store config changed after approval"
        }
      })
    });

    expect(context).toContain("状态：conflict");
    expect(context).toContain("未执行写操作");
    expect(context).toContain("执行前状态与确认单生成时不一致");
    expect(context).toContain("重新发起");
    expect(context).toContain("不要继续执行该写操作");
  });

  it("describes failed as unconfirmed and includes error, write, and verify summaries", () => {
    const context = buildSafeMutationContext({
      action: "approve",
      plan: buildPlan({
        status: "failed",
        result: {
          writeSucceeded: true,
          verifySucceeded: false,
          writeStdout: "write accepted",
          writeStderr: "warning",
          verifySnapshot: {
            status: "1"
          },
          error: "Post-write verification failed"
        }
      })
    });

    expect(context).toContain("状态：failed");
    expect(context).toContain("未能确认最终写入成功");
    expect(context).toContain("Post-write verification failed");
    expect(context).toContain("写入接口返回");
    expect(context).toContain("write accepted");
    expect(context).toContain("回读验证");
    expect(context).toContain("不要重复调用同一写工具");
  });

  it("describes expired as not executed and asks for a new plan", () => {
    const context = buildSafeMutationContext({
      action: "approve",
      plan: buildPlan({
        status: "expired"
      })
    });

    expect(context).toContain("状态：expired");
    expect(context).toContain("确认单已过期");
    expect(context).toContain("未执行写操作");
    expect(context).toContain("重新发起操作并生成新的确认单");
    expect(context).toContain("不要继续执行该写操作");
  });

  it("describes cancelled as cancelled by the user and not executed", () => {
    const context = buildSafeMutationContext({
      action: "cancel",
      plan: buildPlan({
        status: "cancelled"
      })
    });

    expect(context).toContain("用户取消了受保护变更");
    expect(context).toContain("状态：cancelled");
    expect(context).toContain("未执行写操作");
    expect(context).toContain("请停止该变更相关后续步骤");
  });
});
