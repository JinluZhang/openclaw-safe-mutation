import type { ProtectedFieldDefinition } from "./field-schema.js";
import type { MutationExecutionContext, ResolvedPatch } from "./intent-types.js";
import {
  defaultProtectedMutationRegistry,
  type ProtectedMutationRegistry
} from "./mutation-registry.js";
import { buildWritePayload } from "./payload-builder.js";
import {
  readSnapshotFromExecutionContext as readSnapshotFromDefaultExecutionContext
} from "./tool-backed-adapters.js";

export interface ProtectedWriteRequest {
  toolName: string;
  storeId: string;
  payload: Record<string, unknown>;
  beforeSnapshot?: Record<string, unknown>;
  fieldSchema: ProtectedFieldDefinition[];
  fieldSchemaHash: string;
  bindingSnapshot?: unknown;
  executionContext?: MutationExecutionContext;
  approvedPlanId?: string;
  source: "tool" | "exec";
}

export interface ProtectedWriteRequestResolution {
  request?: ProtectedWriteRequest;
  error?: string;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function resolveProtectedWriteRequest(input: {
  toolName: string;
  params: Record<string, unknown>;
  registry?: ProtectedMutationRegistry;
  readSnapshotFromExecutionContext?: (
    executionContext: MutationExecutionContext,
    storeId: string
  ) => Promise<Record<string, unknown>>;
}): Promise<ProtectedWriteRequestResolution | undefined> {
  const registry = input.registry ?? defaultProtectedMutationRegistry;
  const matchedResult = await registry.match({
    toolName: input.toolName,
    params: input.params,
    approvedPlanId: getString(input.params.approvedPlanId)
  });

  if (matchedResult.error) {
    return {
      error: matchedResult.error
    };
  }

  const matched = matchedResult.matched;

  if (!matched) {
    return;
  }

  if (matched.payload) {
    return {
      request: {
        toolName: matched.binding.protectedToolName,
        storeId: matched.resourceId,
        payload: matched.payload,
        executionContext: matched.executionContext,
        fieldSchema: structuredClone(matched.fieldSchema),
        fieldSchemaHash: matched.fieldSchemaHash,
        bindingSnapshot: structuredClone(matched.binding),
        approvedPlanId: matched.approvedPlanId,
        source: matched.source
      }
    };
  }

  if (!matched.fieldChanges || matched.fieldChanges.length === 0) {
    return {
      error: `Protected write binding ${matched.binding.id} did not resolve a payload or patch.`
    };
  }

  const readSnapshot =
    input.readSnapshotFromExecutionContext ??
    readSnapshotFromDefaultExecutionContext;
  const beforeSnapshot = await readSnapshot(
    matched.executionContext,
    matched.resourceId
  );
  const resolvedPatch: ResolvedPatch = {
    kind: "mutation.resolved.patch",
    storeId: matched.resourceId,
    fieldChanges: matched.fieldChanges
  };
  const payload = buildWritePayload(
    beforeSnapshot,
    resolvedPatch,
    matched.fieldSchema
  );

  return {
    request: {
      toolName: matched.binding.protectedToolName,
      storeId: matched.resourceId,
      payload,
      beforeSnapshot,
      fieldSchema: structuredClone(matched.fieldSchema),
      fieldSchemaHash: matched.fieldSchemaHash,
      bindingSnapshot: structuredClone(matched.binding),
      executionContext: matched.executionContext,
      approvedPlanId: matched.approvedPlanId,
      source: matched.source
    }
  };
}
