import { describe, expect, it } from "vitest";

import {
  buildApprovalPrincipal,
  normalizeApprovalPrincipal,
  resolveApprovalIdentity,
  resolveApprovalIdentityFromDispatchSource,
  resolveApprovalIdentityFromSessionSource,
  sameApprovalPrincipal
} from "../../src/approval-principal.js";

describe("approval principal normalization", () => {
  it("normalizes channel-prefixed sender ids into a stable principal", () => {
    expect(
      buildApprovalPrincipal({
        channel: "feishu",
        accountId: "default",
        senderId: "feishu:ou_alice"
      })
    ).toBe("feishu:default:ou_alice");
  });

  it("treats prefixed and raw sender ids as the same approval identity", () => {
    const fromSession = resolveApprovalIdentity({
      channel: "feishu",
      accountId: "default",
      senderId: "feishu:ou_alice"
    });
    const fromEvent = resolveApprovalIdentity({
      channel: "feishu",
      accountId: "default",
      senderId: "ou_alice"
    });

    expect(fromSession).toEqual(
      expect.objectContaining({
        senderId: "ou_alice",
        approvalPrincipal: "feishu:default:ou_alice"
      })
    );
    expect(fromEvent?.approvalPrincipal).toBe(fromSession?.approvalPrincipal);
  });

  it("normalizes persisted principals created before sender id cleanup", () => {
    expect(
      normalizeApprovalPrincipal("feishu:default:feishu:ou_alice")
    ).toBe("feishu:default:ou_alice");
  });

  it("resolves the same principal from dispatch event and hook context", () => {
    const approvalIdentity = resolveApprovalIdentityFromDispatchSource({
      event: {
        channel: "feishu",
        senderId: "ou_alice"
      },
      hook: {
        accountId: "default"
      }
    });

    expect(approvalIdentity).toEqual({
      channel: "feishu",
      senderId: "ou_alice",
      accountId: "default",
      approvalPrincipal: "feishu:default:ou_alice"
    });
  });

  it("resolves the same principal from session state", () => {
    const approvalIdentity = resolveApprovalIdentityFromSessionSource({
      deliveryContext: {
        channel: "feishu",
        accountId: "default"
      },
      origin: {
        provider: "feishu",
        from: "feishu:ou_alice",
        accountId: "default"
      }
    });

    expect(approvalIdentity).toEqual({
      channel: "feishu",
      senderId: "ou_alice",
      accountId: "default",
      approvalPrincipal: "feishu:default:ou_alice"
    });
  });

  it("compares persisted and canonical principals through one helper", () => {
    expect(
      sameApprovalPrincipal(
        "feishu:default:feishu:ou_alice",
        "feishu:default:ou_alice"
      )
    ).toBe(true);
    expect(
      sameApprovalPrincipal("feishu:default:ou_alice", "feishu:default:ou_bob")
    ).toBe(false);
  });
});
