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

export interface ShellMutationInvocation {
  kind: "shell";
  command: string;
  workdir?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizerId;
}

export interface HttpMutationInvocation {
  kind: "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizerId;
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
  compareNormalizer?: SnapshotNormalizerId;
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
  requestedBy: string;
  approvalChannel?: string;
  approvalSenderId?: string;
  approvalAccountId?: string;
  approvalPrincipal?: string;
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
