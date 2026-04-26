import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  renderMutationPlanForText,
  renderMutationPlanStatusForText
} from "./src/channels/text-render.js";
import {
  resolveApprovalIdentityFromDispatchSource,
  resolveApprovalIdentityFromSessionSource,
  type ApprovalSessionIdentitySource
} from "./src/approval-principal.js";
import { runMutateApproveCommand } from "./src/commands/mutate-approve.js";
import { runMutateCancelCommand } from "./src/commands/mutate-cancel.js";
import { guardBeforeToolCall } from "./src/hooks/before-tool-call.js";
import { FileMutationPlanStore } from "./src/file-plan-store.js";
import { ensureProtectedWritePlan } from "./src/protected-write-plan.js";
import { parseTextPlanAction } from "./src/text-plan-actions.js";
import { loadProtectedMutationRegistry } from "./src/mutation-registry.js";
import {
  ToolReadAdapter,
  ToolVerifyAdapter,
  ToolWriteAdapter
} from "./src/tool-backed-adapters.js";

const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    dataDir: {
      type: "string",
      description: "Directory for fake store snapshots and mutation plans"
    },
    protectedMutations: {
      type: "array",
      description:
        "Explicit protected mutation bindings. Each binding must declare the write matcher and read invocation; omitted uses built-in mock binding.",
      items: {
        type: "object",
        additionalProperties: true
      }
    }
  }
} satisfies Record<string, unknown>;

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface HookSessionEntry extends ApprovalSessionIdentitySource {}

export default definePluginEntry({
  id: "safe-mutation",
  name: "Safe Mutation",
  description:
    "Frozen-plan mutation workflow with in-thread text confirmation for OpenClaw",
  configSchema: {
    jsonSchema: pluginConfigJsonSchema
  },
  register(api) {
    const missingApprovedPlanReason =
      "This write path requires an approved mutation plan.";
    const confirmationSentBlockReason =
      [
        "SAFE_MUTATION_APPROVAL_SENT.",
        "The protected write tool call was blocked; the write has not been executed yet.",
        "A frozen approval request has already been sent as a separate message to the originating conversation.",
        "In the final assistant reply, do not retry the tool, do not create or modify a payload, do not repeat the full approval request, and do not promise that you personally will execute the write after the user replies.",
        "Reply briefly in the user's language. For Chinese, say: 已生成变更确认单，点击确认后系统会自动执行。"
      ].join(" ");
    const confirmationDeliveryFailedBlockReason = (planId: string) =>
      [
        `SAFE_MUTATION_APPROVAL_DELIVERY_FAILED planId=${planId}.`,
        "The protected write tool call was blocked; the write has not been executed.",
        "A pending approval plan exists, but the system could not deliver the approval request to the originating conversation.",
        "Do not ask the user to confirm this plan, because they may not have seen the diff.",
        "Reply briefly in the user's language that the write was stopped for approval, the confirmation message could not be delivered, and no change was made. Ask the user to retry later or contact an operator."
      ].join(" ");
    const configuredDataDir = getString(api.pluginConfig?.dataDir);
    const stateDir = api.runtime.state.resolveStateDir();
    const dataDir =
      configuredDataDir !== undefined
        ? api.resolvePath(configuredDataDir)
        : path.join(stateDir, "safe-mutation");
    const mutationRegistry = loadProtectedMutationRegistry(
      api.pluginConfig?.protectedMutations
    );
    const readAdapter = new ToolReadAdapter();
    const writeAdapter = new ToolWriteAdapter();
    const verifyAdapter = new ToolVerifyAdapter();
    const planStore = new FileMutationPlanStore(dataDir);
    const directConfirmationRunIds = new Set<string>();

    function loadHookSessionEntry(
      agentId: string | undefined,
      sessionKey: string
    ): HookSessionEntry | undefined {
      const storePath = api.runtime.agent.session.resolveStorePath(
        api.config.session?.store,
        {
          agentId
        }
      );
      const store = api.runtime.agent.session.loadSessionStore(storePath, {
        skipCache: true
      }) as Record<string, HookSessionEntry>;

      return store[sessionKey];
    }

    function resolveReplyTarget(entry: HookSessionEntry | undefined):
      | {
          channel: string;
          to: string;
          accountId?: string;
          threadId?: string | number;
        }
      | undefined {
      const channel =
        getString(entry?.deliveryContext?.channel) ??
        getString(entry?.lastChannel) ??
        getString(entry?.channel) ??
        getString(entry?.origin?.provider);
      const to =
        getString(entry?.deliveryContext?.to) ?? getString(entry?.lastTo);
      const accountId =
        getString(entry?.deliveryContext?.accountId) ??
        getString(entry?.lastAccountId) ??
        getString(entry?.origin?.accountId);
      const threadId =
        entry?.deliveryContext?.threadId ??
        entry?.lastThreadId ??
        entry?.origin?.threadId;

      if (!channel || !to) {
        return;
      }

      return {
        channel,
        to,
        ...(accountId ? { accountId } : {}),
        ...(threadId !== undefined ? { threadId } : {})
      };
    }

    async function sendPlanToOriginatingConversation(params: {
      text: string;
      entry: HookSessionEntry | undefined;
    }): Promise<boolean> {
      const target = resolveReplyTarget(params.entry);

      if (!target) {
        return false;
      }

      const adapter = await api.runtime.channel.outbound.loadAdapter(
        target.channel as Parameters<
          typeof api.runtime.channel.outbound.loadAdapter
        >[0]
      );

      if (!adapter?.sendText) {
        return false;
      }

      await adapter.sendText({
        cfg: api.config,
        to: target.to,
        text: params.text,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        ...(target.threadId !== undefined
          ? { threadId: target.threadId }
          : {})
      });

      return true;
    }

    api.on("before_dispatch", async (event, hookCtx) => {
      const action = parseTextPlanAction(event.content);

      if (!action) {
        return;
      }

      const approvalIdentity = resolveApprovalIdentityFromDispatchSource({
        event,
        hook: hookCtx
      });
      let planId = action.planId;

      if (!planId) {
        if (!approvalIdentity) {
          return;
        }

        const pendingPlans = await planStore.listPendingByApprovalPrincipal(
          approvalIdentity.approvalPrincipal
        );

        if (pendingPlans.length === 0) {
          return;
        }

        if (pendingPlans.length > 1) {
          return {
            handled: true,
            text: `当前会话有多个待确认计划：${pendingPlans
              .map((plan) => plan.planId)
              .join("、")}。请回复“确认 <planId>”或“取消 <planId>”。`
          };
        }

        planId = pendingPlans[0]!.planId;
      }

      if (!planId) {
        return;
      }

      try {
        const plan =
          action.kind === "approve"
            ? await runMutateApproveCommand(
                {
                  planStore,
                  readAdapter,
                  writeAdapter,
                  verifyAdapter
                },
                {
                  planId,
                  approvedBy:
                    getString(event.senderId) ??
                    getString(hookCtx.senderId) ??
                    "unknown",
                  approvalPrincipal: approvalIdentity?.approvalPrincipal
                }
              )
            : await runMutateCancelCommand(
                {
                  planStore
                },
                {
                  planId,
                  cancelledBy:
                    getString(event.senderId) ??
                    getString(hookCtx.senderId) ??
                    "unknown",
                  approvalPrincipal: approvalIdentity?.approvalPrincipal
                }
              );

        return {
          handled: true,
          text: renderMutationPlanStatusForText(plan)
        };
      } catch (error) {
        return {
          handled: true,
          text: error instanceof Error ? error.message : String(error)
        };
      }
    });

    api.on("before_tool_call", async (event, hookCtx) => {
      const decision = await guardBeforeToolCall(
        {
          planStore,
          protectedMutationRegistry: mutationRegistry
        },
        {
          toolName: event.toolName,
          params: event.params,
          approvedPlanId: getString(event.params.approvedPlanId),
          actor: hookCtx.agentId,
          storeId: getString(event.params.storeId)
        }
      );

      if (decision.action === "block") {
        if (
          decision.reason === missingApprovedPlanReason &&
          decision.protectedWriteRequest
        ) {
          const runId = event.runId ?? hookCtx.runId;

          if (runId && directConfirmationRunIds.has(runId)) {
            return {
              block: true,
              blockReason: confirmationSentBlockReason
            };
          }

          const storeId = decision.protectedWriteRequest.storeId;
          const payload = decision.protectedWriteRequest.payload;
          const sessionKey = hookCtx.sessionKey;

          if (sessionKey) {
            const sessionEntry = loadHookSessionEntry(
              hookCtx.agentId,
              sessionKey
            );
            const approvalIdentity =
              resolveApprovalIdentityFromSessionSource(sessionEntry);

            try {
              const protectedWritePlan = await ensureProtectedWritePlan(
                {
                  planStore,
                  readAdapter
                },
                {
                  storeId,
                  writePayload: payload,
                  beforeSnapshot: decision.protectedWriteRequest.beforeSnapshot,
                  executionContext:
                    decision.protectedWriteRequest.executionContext,
                  requestedBy:
                    approvalIdentity?.senderId ??
                    getString(sessionEntry?.origin?.from) ??
                    hookCtx.agentId ??
                    "unknown",
                  approvalChannel: approvalIdentity?.channel,
                  approvalSenderId: approvalIdentity?.senderId,
                  approvalAccountId: approvalIdentity?.accountId,
                  approvalPrincipal: approvalIdentity?.approvalPrincipal,
                  sessionKey,
                  channel:
                    approvalIdentity?.channel ??
                    getString(sessionEntry?.deliveryContext?.channel) ??
                    getString(sessionEntry?.lastChannel) ??
                    getString(sessionEntry?.channel) ??
                    getString(sessionEntry?.origin?.provider)
                }
              );
              const planText = protectedWritePlan.blockedByOtherActivePlan
                ? [
                    `门店 ${storeId} 已有待处理变更计划 ${protectedWritePlan.plan.planId}，请先确认、取消或等待其过期。`,
                    "",
                    renderMutationPlanForText(protectedWritePlan.plan)
                  ].join("\n")
                : renderMutationPlanForText(protectedWritePlan.plan);
              const delivered = await sendPlanToOriginatingConversation({
                text: planText,
                entry: sessionEntry
              });

              if (delivered) {
                if (runId) {
                  directConfirmationRunIds.add(runId);
                }

                api.logger.info(
                  `safe-mutation sent protected-write confirmation plan=${protectedWritePlan.plan.planId} sessionKey=${sessionKey}`
                );

                return {
                  block: true,
                  blockReason: confirmationSentBlockReason
                };
              }

              api.logger.warn(
                `safe-mutation could not resolve an outbound target for protected write confirmation sessionKey=${sessionKey}`
              );

              return {
                block: true,
                blockReason: confirmationDeliveryFailedBlockReason(
                  protectedWritePlan.plan.planId
                )
              };
            } catch (error) {
              api.logger.warn(
                `safe-mutation failed to create or deliver protected write confirmation: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }

        return {
          block: true,
          blockReason: decision.reason
        };
      }

      return;
    });

    api.on("agent_end", (_event, ctx) => {
      if (ctx.runId) {
        directConfirmationRunIds.delete(ctx.runId);
      }
    });

    api.logger.info(
      `safe-mutation plugin loaded with dataDir=${dataDir}, protectedMutationBindings=${mutationRegistry.bindings
        .map((binding) => binding.id)
        .join(",")}`
    );
  }
});
