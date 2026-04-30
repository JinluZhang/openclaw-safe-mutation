import { describe, expect, it } from "vitest";

import { buildApprovalPrincipal } from "../../src/approval-principal.js";
import { buildDiffItems } from "../../src/diff.js";
import { guardBeforeToolCall } from "../../src/hooks/before-tool-call.js";
import type { MutationPlan } from "../../src/intent-types.js";
import { ProtectedMutationRegistry } from "../../src/mutation-registry.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";
import { shopFieldSchema } from "../helpers/generic-schema.js";
import {
  hashNormalizedSnapshot,
  normalizeSnapshot
} from "../../src/snapshot-normalizer.js";

const beforeSnapshot = {
  promotion: {
    full_reduction_tiers: [
      { threshold: 25, reduction: 15 },
      { threshold: 40, reduction: 20 }
    ]
  }
} satisfies Record<string, unknown>;

const writePayload = {
  promotion: {
    full_reduction_tiers: [
      { threshold: 20, reduction: 15 },
      { threshold: 40, reduction: 20 }
    ]
  }
} satisfies Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveDirectProtectedWriteRequest({
  toolName,
  params
}: {
  toolName: string;
  params: Record<string, unknown>;
}) {
  if (toolName !== "mock-full-reduction-config") {
    return;
  }

  if (typeof params.storeId !== "string" || !isRecord(params.payload)) {
    return;
  }

  return {
    request: {
      toolName: "mock-full-reduction-config",
      storeId: params.storeId,
      payload: structuredClone(params.payload),
      fieldSchema: shopFieldSchema,
      fieldSchemaHash: "schema-hash",
      approvedPlanId:
        typeof params.approvedPlanId === "string"
          ? params.approvedPlanId
          : undefined,
      source: "tool" as const
    }
  };
}

function buildApprovedPlan(): MutationPlan {
  const resolvedPatch = {
    kind: "mutation.resolved.patch" as const,
    storeId: "store-1",
    fieldChanges: [
      {
        fieldId: "full_reduction_tiers",
        operation: "replace_item" as const,
        normalizedInput: writePayload.promotion.full_reduction_tiers
      }
    ]
  };

  return {
    planId: "plan-guard",
    mutationKind: "promotion.full_reduction_tiers",
    status: "approved",
    storeId: "store-1",
    userText: "把满减从 25-15 改成 20-15",
    interpretationText: "修改字段「满减档位(full_reduction_tiers)」",
    beforeSnapshot,
    beforeHash: hashNormalizedSnapshot(normalizeSnapshot(beforeSnapshot)),
    resolvedPatch,
    writePayload,
    diffItems: buildDiffItems(
      beforeSnapshot,
      writePayload,
      resolvedPatch,
      [
        {
          fieldId: "full_reduction_tiers",
          label: "满减档位",
          valueType: "json",
          readPath: "promotion.full_reduction_tiers"
        }
      ]
    ),
    fieldSchemaSnapshot: shopFieldSchema,
    fieldSchemaHash: "schema-hash",
    requestedBy: "alice",
    approvedBy: "alice",
    approvalPrincipal: buildApprovalPrincipal({
      channel: "feishu",
      accountId: "default",
      senderId: "alice"
    }),
    approvedPrincipal: buildApprovalPrincipal({
      channel: "feishu",
      accountId: "default",
      senderId: "alice"
    }),
    createdAtMs: 1,
    expiresAtMs: 1000,
    approvedAtMs: 2,
    idempotencyKey: "idem-guard"
  };
}

describe("OpenClaw before_tool_call guard", () => {
  it("allows unrelated exec commands", async () => {
    const planStore = new InMemoryMutationPlanStore();

    const decision = await guardBeforeToolCall(
      {
        planStore,
        resolveProtectedWriteRequest: resolveDirectProtectedWriteRequest,
        now: () => 10
      },
      {
        toolName: "exec",
        params: {
          command:
            "python3 /Users/test/openclaw/workspace/scripts/unrelated_cli.py write --poiid 10001"
        }
      }
    );

    expect(decision).toEqual({
      action: "allow"
    });
  });

  it("blocks protected exec writes without approvedPlanId", async () => {
    const planStore = new InMemoryMutationPlanStore();

    const decision = await guardBeforeToolCall(
      {
        planStore,
        resolveProtectedWriteRequest: async ({ toolName, params }) => {
          if (toolName !== "exec") {
            return;
          }

          return {
            request: {
              toolName: "mock-full-reduction-config",
              storeId: "store-1",
              payload: writePayload,
              fieldSchema: shopFieldSchema,
              fieldSchemaHash: "schema-hash",
              source: "exec"
            }
          };
        },
        now: () => 10
      },
      {
        toolName: "exec",
        params: {
          command:
            "python3 /Users/test/openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --poiid 10001 --tier-1-threshold 20 --tier-1-discount 15 --format json"
        }
      }
    );

    expect(decision).toEqual({
      action: "block",
      reason: "This write path requires an approved mutation plan.",
      protectedWriteRequest: {
        toolName: "mock-full-reduction-config",
        storeId: "store-1",
        payload: writePayload,
        fieldSchema: shopFieldSchema,
        fieldSchemaHash: "schema-hash",
        source: "exec"
      }
    });
  });

  it("blocks protected writes without approvedPlanId", async () => {
    const planStore = new InMemoryMutationPlanStore();
    await planStore.create(buildApprovedPlan());

    const decision = await guardBeforeToolCall(
      {
        planStore,
        resolveProtectedWriteRequest: resolveDirectProtectedWriteRequest,
        now: () => 10
      },
      {
        toolName: "mock-full-reduction-config",
        params: {
          storeId: "store-1",
          payload: writePayload
        },
        actor: "worker-agent"
      }
    );

    expect(decision).toEqual({
      action: "block",
      reason: "This write path requires an approved mutation plan.",
      protectedWriteRequest: {
        toolName: "mock-full-reduction-config",
        storeId: "store-1",
        payload: writePayload,
        fieldSchema: shopFieldSchema,
        fieldSchemaHash: "schema-hash",
        approvedPlanId: undefined,
        source: "tool"
      }
    });
  });

  it("fails closed when a protected write tool has no matching read binding", async () => {
    const planStore = new InMemoryMutationPlanStore();

    const decision = await guardBeforeToolCall(
      {
        planStore,
        protectedMutationRegistry: new ProtectedMutationRegistry([
          {
            id: "direct-tool",
            protectedToolName: "mock-full-reduction-config",
            match: {
              kind: "tool",
              toolName: "mock-full-reduction-config",
              resourceParamPath: "missingStoreId",
              payloadParamPath: "payload"
            },
            fieldSchema: {
              kind: "inline",
              fields: shopFieldSchema
            },
            read: {
              kind: "shell",
              commandTokens: ["echo", "{}"]
            },
            write: {
              kind: "shell",
              commandTokens: ["echo", "{}"]
            }
          }
        ]),
        now: () => 10
      },
      {
        toolName: "mock-full-reduction-config",
        params: {
          storeId: "store-1",
          payload: writePayload
        }
      }
    );

    expect(decision).toEqual({
      action: "block",
      reason:
        "Protected write tool has no matching mutation binding or read configuration."
    });
  });

  it("blocks writes when the frozen payload and tool params differ", async () => {
    const planStore = new InMemoryMutationPlanStore();
    await planStore.create(buildApprovedPlan());

    const decision = await guardBeforeToolCall(
      {
        planStore,
        resolveProtectedWriteRequest: resolveDirectProtectedWriteRequest,
        now: () => 10
      },
      {
        toolName: "mock-full-reduction-config",
        approvedPlanId: "plan-guard",
        params: {
          approvedPlanId: "plan-guard",
          storeId: "store-1",
          payload: {
            promotion: {
              full_reduction_tiers: [
                { threshold: 20, reduction: 10 },
                { threshold: 40, reduction: 20 }
              ]
            }
          }
        },
        actor: "worker-agent"
      }
    );

    expect(decision).toEqual({
      action: "block",
      reason: "Write payload does not match the approved frozen plan.",
      protectedWriteRequest: {
        toolName: "mock-full-reduction-config",
        storeId: "store-1",
        payload: {
          promotion: {
            full_reduction_tiers: [
              { threshold: 20, reduction: 10 },
              { threshold: 40, reduction: 20 }
            ]
          }
        },
        fieldSchema: shopFieldSchema,
        fieldSchemaHash: "schema-hash",
        approvedPlanId: "plan-guard",
        source: "tool"
      }
    });
  });

  it("allows the write path only when the approved plan and payload match exactly", async () => {
    const planStore = new InMemoryMutationPlanStore();
    await planStore.create(buildApprovedPlan());

    const decision = await guardBeforeToolCall(
      {
        planStore,
        resolveProtectedWriteRequest: resolveDirectProtectedWriteRequest,
        now: () => 10
      },
      {
        toolName: "mock-full-reduction-config",
        approvedPlanId: "plan-guard",
        params: {
          approvedPlanId: "plan-guard",
          storeId: "store-1",
          payload: writePayload
        },
        actor: "worker-agent"
      }
    );

    expect(decision).toEqual({
      action: "allow"
    });
  });
});
