export type MutationOperation =
  | "set"
  | "replace_item"
  | "add_item"
  | "remove_item"
  | "enable"
  | "disable";

export type MutationPlanStatus =
  | "draft"
  | "pending_ack"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "conflict"
  | "cancelled"
  | "expired";

export type ApprovalDeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "unknown";

export interface ResolvedPatchFieldChange {
  fieldId: string;
  operation: MutationOperation;
  normalizedInput: unknown;
}

export interface ResolvedPatch {
  kind: "mutation.resolved.patch";
  storeId: string;
  fieldChanges: ResolvedPatchFieldChange[];
}

export interface DiffItem {
  fieldId: string;
  label: string;
  before: unknown;
  after: unknown;
  display?: {
    format?: "plain" | "json" | "currency" | "percent" | "template";
    template?: string;
  };
}

export interface MutationResult {
  writeSucceeded?: boolean;
  verifySucceeded?: boolean;
  writeStdout?: string;
  writeStderr?: string;
  verifySnapshot?: Record<string, unknown>;
  error?: string;
}

export type SnapshotNormalizerId =
  | "none"
  | "mockFullReductionRead"
  | "stripVolatileFields";

export type SnapshotNormalizerSpec =
  | { kind: "none" }
  | { kind: "stripFields"; paths: string[] }
  | { kind: "pickPath"; path: string }
  | { kind: "renamePath"; from: string; to: string }
  | { kind: "compose"; steps: SnapshotNormalizerSpec[] };

export type SnapshotNormalizer = SnapshotNormalizerId | SnapshotNormalizerSpec;

export interface ShellMutationInvocation {
  kind: "shell";
  command: string;
  workdir?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizer;
}

export interface HttpMutationInvocation {
  kind: "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizer;
}

export type MutationInvocation =
  | ShellMutationInvocation
  | HttpMutationInvocation;

export interface ConfiguredMutationExecutionContext {
  kind: "configured_mutation";
  bindingId: string;
  protectedToolName: string;
  resourceId: string;
  readInvocation: MutationInvocation;
  writeInvocation: MutationInvocation;
  verifyInvocation?: MutationInvocation;
  compareNormalizer?: SnapshotNormalizer;
  workdir?: string;
}

export type MutationExecutionContext = ConfiguredMutationExecutionContext;

export interface MutationPlan {
  planId: string;
  mutationKind: string;
  status: MutationPlanStatus;
  storeId: string;
  userText: string;
  interpretationText: string;
  beforeSnapshot: Record<string, unknown>;
  beforeHash: string;
  resolvedPatch: ResolvedPatch;
  writePayload: Record<string, unknown>;
  diffItems: DiffItem[];
  fieldSchemaSnapshot: import("./field-schema.js").ProtectedFieldDefinition[];
  fieldSchemaHash: string;
  bindingSnapshot?: unknown;
  requestedBy: string;
  approvalChannel?: string;
  approvalSenderId?: string;
  approvalAccountId?: string;
  approvalPrincipal?: string;
  approvalDeliveryStatus?: ApprovalDeliveryStatus;
  approvalMessageId?: string;
  approvalDeliveredAtMs?: number;
  approvalReadAtMs?: number;
  approvedBy?: string;
  approvedPrincipal?: string;
  executionContext?: MutationExecutionContext;
  sessionKey?: string;
  channel?: string;
  createdAtMs: number;
  expiresAtMs: number;
  approvedAtMs?: number;
  executedAtMs?: number;
  finishedAtMs?: number;
  idempotencyKey: string;
  version?: number;
  result?: MutationResult;
}

export const ACTIVE_PLAN_STATUSES: readonly MutationPlanStatus[] = [
  "pending_ack",
  "approved",
  "executing"
];

export const TERMINAL_PLAN_STATUSES: readonly MutationPlanStatus[] = [
  "succeeded",
  "failed",
  "conflict",
  "cancelled",
  "expired"
];
