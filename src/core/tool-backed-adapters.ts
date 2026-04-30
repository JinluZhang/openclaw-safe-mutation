import { spawn } from "node:child_process";

import type { ReadAdapter } from "./adapters/read-adapter.js";
import type { VerifyAdapter } from "./adapters/verify-adapter.js";
import type {
  WriteAdapter,
  WriteAdapterResult
} from "./adapters/write-adapter.js";
import type {
  MutationExecutionContext,
  MutationInvocation,
  SnapshotNormalizer,
  SnapshotNormalizerSpec
} from "./intent-types.js";
import { getValueAtPath, setValueAtPath } from "./object-path.js";

interface ShellCommandResult extends WriteAdapterResult {
  exitCode: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCommandError(result: ShellCommandResult): string {
  const stderr = result.stderr.trim();

  if (!stderr) {
    return `Command exited with code ${result.exitCode}`;
  }

  return stderr;
}

function stripVolatileFields(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const normalized = structuredClone(snapshot);

  delete normalized.version;
  delete normalized.updated_at;

  return normalized;
}

function normalizeMockFullReductionReadSnapshot(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const normalized = structuredClone(snapshot);
  const tierList = normalized.full_reduction_tiers;

  delete normalized.full_reduction_tiers;

  if (!Array.isArray(tierList)) {
    return normalized;
  }

  const tiers = tierList.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const threshold = item.threshold;
    const discount = item.discount;

    if (typeof threshold !== "number" || typeof discount !== "number") {
      return [];
    }

    return [
      {
        threshold,
        reduction: discount
      }
    ];
  });

  if (tiers.length !== tierList.length) {
    throw new Error("Mock full-reduction read output contains invalid tier data.");
  }

  return setValueAtPath(normalized, "promotion.full_reduction_tiers", tiers);
}

function deletePath(
  snapshot: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  const parts = path.split(".").filter(Boolean);
  const root = structuredClone(snapshot);
  let cursor: unknown = root;

  for (const part of parts.slice(0, -1)) {
    if (!isRecord(cursor)) {
      return root;
    }

    cursor = cursor[part];
  }

  if (isRecord(cursor) && parts.length > 0) {
    delete cursor[parts[parts.length - 1]!];
  }

  return root;
}

function applyNormalizerSpec(
  normalizer: SnapshotNormalizerSpec,
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  switch (normalizer.kind) {
    case "none":
      return structuredClone(snapshot);
    case "stripFields":
      return normalizer.paths.reduce(
        (current, path) => deletePath(current, path),
        structuredClone(snapshot)
      );
    case "pickPath": {
      const selected = getValueAtPath(snapshot, normalizer.path);
      return isRecord(selected) ? structuredClone(selected) : {};
    }
    case "renamePath": {
      const selected = getValueAtPath(snapshot, normalizer.from);
      const stripped = deletePath(snapshot, normalizer.from);
      return selected === undefined
        ? stripped
        : setValueAtPath(stripped, normalizer.to, selected);
    }
    case "compose":
      return normalizer.steps.reduce(
        (current, step) => applyNormalizerSpec(step, current),
        structuredClone(snapshot)
      );
  }
}

function applySnapshotNormalizer(
  normalizer: SnapshotNormalizer | undefined,
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  if (typeof normalizer === "object" && normalizer !== null) {
    return applyNormalizerSpec(normalizer, snapshot);
  }

  switch (normalizer ?? "none") {
    case "none":
      return structuredClone(snapshot);
    case "mockFullReductionRead":
      return normalizeMockFullReductionReadSnapshot(snapshot);
    case "stripVolatileFields":
      return stripVolatileFields(snapshot);
    default:
      return structuredClone(snapshot);
  }
}

function requireConfiguredMutationContext(
  executionContext: MutationExecutionContext | undefined,
  storeId: string
): MutationExecutionContext {
  if (!executionContext || executionContext.kind !== "configured_mutation") {
    throw new Error(
      `Store ${storeId} is missing configured protected mutation execution context.`
    );
  }

  return executionContext;
}

async function runShellCommand(params: {
  command: string;
  workdir?: string;
}): Promise<ShellCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", params.command], {
      cwd: params.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function runHttpInvocation(
  invocation: Extract<MutationInvocation, { kind: "http" }>
): Promise<ShellCommandResult> {
  const response = await fetch(invocation.url, {
    method: invocation.method ?? "GET",
    headers: invocation.headers,
    body: invocation.body
  });
  const stdout = await response.text();

  return {
    exitCode: response.ok ? 0 : response.status,
    stdout,
    stderr: response.ok ? "" : response.statusText
  };
}

async function runInvocation(
  invocation: MutationInvocation
): Promise<ShellCommandResult> {
  if (invocation.kind === "shell") {
    return runShellCommand({
      command: invocation.command,
      workdir: invocation.workdir
    });
  }

  return runHttpInvocation(invocation);
}

function parseInvocationJsonResult(params: {
  result: ShellCommandResult;
  invocation: MutationInvocation;
  storeId: string;
}): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(params.result.stdout);
  } catch (error) {
    throw new Error(
      `Configured protected mutation read did not return valid JSON for ${
        params.storeId
      }: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const selected = params.invocation.resultPath
    ? getValueAtPath(
        isRecord(parsed) ? parsed : {},
        params.invocation.resultPath
      )
    : parsed;

  if (!isRecord(selected)) {
    throw new Error(
      `Configured protected mutation read returned a non-object payload for ${params.storeId}.`
    );
  }

  return applySnapshotNormalizer(params.invocation.normalizer, selected);
}

export async function readSnapshotFromExecutionContext(
  executionContext: MutationExecutionContext | undefined,
  storeId: string
): Promise<Record<string, unknown>> {
  const context = requireConfiguredMutationContext(executionContext, storeId);
  const result = await runInvocation(context.readInvocation);

  if (result.exitCode !== 0) {
    throw new Error(
      `Configured protected mutation read failed for ${storeId}: ${formatCommandError(result)}`
    );
  }

  return parseInvocationJsonResult({
    result,
    invocation: context.readInvocation,
    storeId
  });
}

export function normalizeVerificationSnapshot(params: {
  snapshot: Record<string, unknown>;
  executionContext?: MutationExecutionContext;
}): Record<string, unknown> {
  return applySnapshotNormalizer(
    params.executionContext?.compareNormalizer,
    params.snapshot
  );
}

export class ToolReadAdapter implements ReadAdapter {
  async readCurrentConfig(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
  }): Promise<Record<string, unknown>> {
    return readSnapshotFromExecutionContext(params.executionContext, params.storeId);
  }
}

export class ToolVerifyAdapter implements VerifyAdapter {
  async verifyCurrentConfig(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
  }): Promise<Record<string, unknown>> {
    const context = requireConfiguredMutationContext(
      params.executionContext,
      params.storeId
    );
    const invocation = context.verifyInvocation ?? context.readInvocation;
    const result = await runInvocation(invocation);

    if (result.exitCode !== 0) {
      throw new Error(
        `Configured protected mutation verification read failed for ${
          params.storeId
        }: ${formatCommandError(result)}`
      );
    }

    return parseInvocationJsonResult({
      result,
      invocation,
      storeId: params.storeId
    });
  }
}

export class ToolWriteAdapter implements WriteAdapter {
  async writeConfig(params: {
    storeId: string;
    payload: Record<string, unknown>;
    executionContext?: MutationExecutionContext;
  }): Promise<WriteAdapterResult> {
    const context = requireConfiguredMutationContext(
      params.executionContext,
      params.storeId
    );
    const result = await runInvocation(context.writeInvocation);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}
