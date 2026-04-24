export interface ApprovalIdentityInput {
  channel?: string;
  senderId?: string;
  accountId?: string;
}

export interface ApprovalDispatchIdentitySource {
  channel?: string;
  senderId?: string;
  accountId?: string;
}

export interface ApprovalSessionDeliveryContext {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}

export interface ApprovalSessionOrigin {
  provider?: string;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}

export interface ApprovalSessionIdentitySource {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  deliveryContext?: ApprovalSessionDeliveryContext;
  origin?: ApprovalSessionOrigin;
}

export interface ApprovalIdentity {
  channel: string;
  senderId: string;
  accountId?: string;
  approvalPrincipal: string;
}

function getTrimmed(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeSenderId(input: {
  channel?: string;
  senderId?: string;
}): string | undefined {
  const channel = getTrimmed(input.channel);
  const senderId = getTrimmed(input.senderId);

  if (!senderId) {
    return;
  }

  if (!channel) {
    return senderId;
  }

  const channelPrefix = `${channel}:`;
  return senderId.startsWith(channelPrefix)
    ? senderId.slice(channelPrefix.length)
    : senderId;
}

export function normalizeApprovalPrincipal(
  approvalPrincipal: string | undefined
): string | undefined {
  const normalized = getTrimmed(approvalPrincipal);

  if (!normalized) {
    return;
  }

  const parts = normalized.split(":");
  const channel = parts.shift();

  if (!channel || parts.length === 0) {
    return normalized;
  }

  if (parts.length === 1) {
    const senderId = normalizeSenderId({
      channel,
      senderId: parts[0]
    });

    return senderId ? `${channel}:${senderId}` : normalized;
  }

  const accountId = parts.shift();
  const senderId = normalizeSenderId({
    channel,
    senderId: parts.join(":")
  });

  if (!accountId || !senderId) {
    return normalized;
  }

  return `${channel}:${accountId}:${senderId}`;
}

export function sameApprovalPrincipal(
  left: string | undefined,
  right: string | undefined
): boolean {
  const normalizedLeft = normalizeApprovalPrincipal(left);
  const normalizedRight = normalizeApprovalPrincipal(right);

  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight
  );
}

export function buildApprovalPrincipal(input: {
  channel: string;
  senderId: string;
  accountId?: string;
}): string {
  const channel = getTrimmed(input.channel);
  const senderId = normalizeSenderId({
    channel,
    senderId: input.senderId
  });
  const accountId = getTrimmed(input.accountId);

  if (!channel || !senderId) {
    throw new Error("channel and senderId are required to build approvalPrincipal");
  }

  return accountId
    ? `${channel}:${accountId}:${senderId}`
    : `${channel}:${senderId}`;
}

export function resolveApprovalIdentity(
  input: ApprovalIdentityInput
): ApprovalIdentity | undefined {
  const channel = getTrimmed(input.channel);
  const senderId = normalizeSenderId({
    channel,
    senderId: input.senderId
  });
  const accountId = getTrimmed(input.accountId);

  if (!channel || !senderId) {
    return;
  }

  return {
    channel,
    senderId,
    ...(accountId ? { accountId } : {}),
    approvalPrincipal: buildApprovalPrincipal({
      channel,
      senderId,
      ...(accountId ? { accountId } : {})
    })
  };
}

export function resolveApprovalIdentityFromDispatchSource(params: {
  event?: ApprovalDispatchIdentitySource;
  hook?: ApprovalDispatchIdentitySource;
}): ApprovalIdentity | undefined {
  return resolveApprovalIdentity({
    channel:
      getTrimmed(params.event?.channel) ?? getTrimmed(params.hook?.channel),
    senderId:
      getTrimmed(params.event?.senderId) ??
      getTrimmed(params.hook?.senderId),
    accountId:
      getTrimmed(params.event?.accountId) ??
      getTrimmed(params.hook?.accountId)
  });
}

export function resolveApprovalIdentityFromSessionSource(
  source: ApprovalSessionIdentitySource | undefined
): ApprovalIdentity | undefined {
  return resolveApprovalIdentity({
    channel:
      getTrimmed(source?.deliveryContext?.channel) ??
      getTrimmed(source?.lastChannel) ??
      getTrimmed(source?.channel) ??
      getTrimmed(source?.origin?.provider),
    senderId: getTrimmed(source?.origin?.from),
    accountId:
      getTrimmed(source?.deliveryContext?.accountId) ??
      getTrimmed(source?.lastAccountId) ??
      getTrimmed(source?.origin?.accountId)
  });
}
