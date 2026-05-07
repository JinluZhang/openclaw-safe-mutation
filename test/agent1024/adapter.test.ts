import { describe, expect, it } from "vitest";

import type { ReadAdapter } from "../../src/adapters/read-adapter.js";
import type { VerifyAdapter } from "../../src/adapters/verify-adapter.js";
import type { WriteAdapter } from "../../src/adapters/write-adapter.js";
import { handleAgent1024PreToolUse } from "../../src/agent1024/handlers/pre-tool-use.js";
import { handleAgent1024UserMessageReceived } from "../../src/agent1024/handlers/user-message-received.js";
import { InMemoryAgent1024ApprovalNotifier } from "../../src/agent1024/notifier.js";
import type { ProtectedMutationBinding } from "../../src/mutation-registry.js";
import { ProtectedMutationRegistry } from "../../src/mutation-registry.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";

const productStatusBinding: ProtectedMutationBinding = {
  id: "wm-product-set-status",
  protectedToolName: "wm-product-set-status",
  match: {
    kind: "cli",
    toolName: "bash",
    commandPrefix: ["wm-merchant", "product", "set-status"],
    positionals: [
      {
        variableName: "merchantId"
      },
      {
        variableName: "productId"
      }
    ],
    resourceIdTemplate: "wm-product-status:{{merchantId}}:{{productId}}",
    mutableFlags: {
      "--status": {
        fieldId: "status"
      }
    }
  },
  fieldSchema: {
    kind: "inline",
    fields: [
      {
        fieldId: "status",
        label: "商品状态",
        valueType: "enum",
        enumValues: ["0", "1"],
        readPath: "status",
        requiredInPayload: true
      }
    ]
  },
  read: {
    kind: "shell",
    commandTokens: [
      "wm-merchant",
      "product",
      "get-status",
      "{{merchantId}}",
      "{{productId}}"
    ]
  },
  verify: {
    kind: "shell",
    commandTokens: [
      "wm-merchant",
      "product",
      "get-status",
      "{{merchantId}}",
      "{{productId}}"
    ]
  }
};

class FakeReadAdapter implements ReadAdapter {
  constructor(public snapshot: Record<string, unknown>) {}

  async readCurrentConfig(): Promise<Record<string, unknown>> {
    return structuredClone(this.snapshot);
  }
}

class FakeVerifyAdapter implements VerifyAdapter {
  constructor(public snapshot: Record<string, unknown>) {}

  async verifyCurrentConfig(): Promise<Record<string, unknown>> {
    return structuredClone(this.snapshot);
  }
}

class FakeWriteAdapter implements WriteAdapter {
  readonly calls: Record<string, unknown>[] = [];

  constructor(private readonly verifyAdapter: FakeVerifyAdapter) {}

  async writeConfig(params: {
    payload: Record<string, unknown>;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    this.calls.push(structuredClone(params.payload));
    this.verifyAdapter.snapshot = structuredClone(params.payload);

    return {
      exitCode: 0,
      stdout: "ok",
      stderr: ""
    };
  }
}

describe("agent1024 adapter", () => {
  it("blocks protected CLI writes and sends an IM approval request", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter({ status: "1" });
    const notifier = new InMemoryAgent1024ApprovalNotifier();

    const response = await handleAgent1024PreToolUse(
      {
        planStore,
        readAdapter,
        notifier,
        protectedMutationRegistry: new ProtectedMutationRegistry([
          productStatusBinding
        ]),
        now: () => 100
      },
      {
        paas: "wm",
        conversationId: "conv-1",
        userMis: "alice",
        toolName: "bash",
        toolArguments: {
          command:
            "wm-merchant product set-status 23202203439 23200980370 --status 0"
        }
      }
    );

    expect(response.decision).toBe("block");
    expect(response.reason).toContain("SAFE_MUTATION_APPROVAL_SENT");
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.text).toContain("Plan:");
    expect(notifier.sent[0]!.text).toContain("确认方式：回复“确认”后由系统直接执行");
    expect(notifier.sent[0]!.text).toContain("取消方式：回复“取消”放弃本次变更");

    const plans = await planStore.listPendingByApprovalPrincipal(
      "wm:conv-1:alice"
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual(
      expect.objectContaining({
        approvalDeliveryStatus: "sent",
        approvalMessageId: `msg_${plans[0]!.planId}`,
        status: "pending_ack",
        storeId: "wm-product-status:23202203439:23200980370",
        writePayload: {
          status: "0"
        }
      })
    );
  });

  it("executes a confirmed frozen plan and returns safeMutationContext", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter({ status: "1" });
    const verifyAdapter = new FakeVerifyAdapter({ status: "1" });
    const writeAdapter = new FakeWriteAdapter(verifyAdapter);
    const notifier = new InMemoryAgent1024ApprovalNotifier();
    const registry = new ProtectedMutationRegistry([productStatusBinding]);

    await handleAgent1024PreToolUse(
      {
        planStore,
        readAdapter,
        notifier,
        protectedMutationRegistry: registry,
        now: () => 100
      },
      {
        paas: "wm",
        conversationId: "conv-1",
        userMis: "alice",
        toolName: "bash",
        toolArguments: {
          command:
            "wm-merchant product set-status 23202203439 23200980370 --status 0"
        }
      }
    );

    const response = await handleAgent1024UserMessageReceived(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 101
      },
      {
        paas: "wm",
        conversationId: "conv-1",
        userMis: "alice",
        messageContent: "确认"
      }
    );

    expect(response).toEqual(
      expect.objectContaining({
        decision: "allow",
        extraContext: {
          safeMutationContext: expect.stringContaining("状态：succeeded")
        }
      })
    );
    expect(writeAdapter.calls).toEqual([
      {
        status: "0"
      }
    ]);
  });
});
