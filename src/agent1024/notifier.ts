import type { MutationPlan, ApprovalDeliveryStatus } from "../core/intent-types.js";
import type { Agent1024PreToolUsePayload } from "./response-types.js";

export interface Agent1024ApprovalNotificationInput {
  payload: Agent1024PreToolUsePayload;
  plan: MutationPlan;
  text: string;
}

export interface Agent1024ApprovalNotificationResult {
  ok: boolean;
  status: ApprovalDeliveryStatus;
  messageId?: string;
  error?: string;
}

export interface Agent1024ApprovalNotifier {
  sendApproval(
    input: Agent1024ApprovalNotificationInput
  ): Promise<Agent1024ApprovalNotificationResult>;
}

export class InMemoryAgent1024ApprovalNotifier
  implements Agent1024ApprovalNotifier
{
  readonly sent: Agent1024ApprovalNotificationInput[] = [];

  constructor(
    private readonly options: {
      fail?: boolean;
      messageIdFactory?: () => string | undefined;
    } = {}
  ) {}

  async sendApproval(
    input: Agent1024ApprovalNotificationInput
  ): Promise<Agent1024ApprovalNotificationResult> {
    this.sent.push(input);

    if (this.options.fail) {
      return {
        ok: false,
        status: "failed",
        error: "Mock approval notifier failed"
      };
    }

    const messageId = this.options.messageIdFactory?.() ?? `msg_${input.plan.planId}`;

    return {
      ok: true,
      status: messageId ? "sent" : "unknown",
      ...(messageId ? { messageId } : {})
    };
  }
}
