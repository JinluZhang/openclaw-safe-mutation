import type { ReadAdapter } from "../core/adapters/read-adapter.js";
import type { VerifyAdapter } from "../core/adapters/verify-adapter.js";
import type {
  WriteAdapter,
  WriteAdapterResult
} from "../core/adapters/write-adapter.js";
import type {
  MutationExecutionContext,
  MutationInvocation
} from "../core/intent-types.js";
import { getValueAtPath } from "../core/object-path.js";
import { applySnapshotNormalizer } from "../core/tool-backed-adapters.js";

export type Agent1024RuntimeExecutionPhase =
  | "read_before"
  | "write"
  | "verify_after";

export interface Agent1024RuntimeExecutionRequest {
  paas?: string;
  conversationId?: string;
  userMis?: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  invocation: MutationInvocation;
  safeMutation?: {
    planId?: string;
    phase: Agent1024RuntimeExecutionPhase;
    idempotencyKey?: string;
    payloadHash?: string;
  };
  traceId?: string;
}

export interface Agent1024RuntimeExecutionResult extends WriteAdapterResult {
  executionId?: string;
  status: "succeeded" | "failed";
  startedAt?: number;
  finishedAt?: number;
}

export interface Agent1024RuntimeExecutionClient {
  execute(
    request: Agent1024RuntimeExecutionRequest
  ): Promise<Agent1024RuntimeExecutionResult>;
}

export interface Agent1024RuntimeAdapterOptions {
  client: Agent1024RuntimeExecutionClient;
  paas?: string;
  conversationId?: string;
  userMis?: string;
  traceId?: string;
  planId?: string;
  idempotencyKeyPrefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invocationToRuntimeTool(
  invocation: MutationInvocation
): {
  toolName: string;
  toolArguments: Record<string, unknown>;
} {
  if (invocation.kind === "shell") {
    return {
      toolName: "bash_execute",
      toolArguments: {
        command: invocation.command,
        ...(invocation.workdir ? { workdir: invocation.workdir } : {})
      }
    };
  }

  return {
    toolName: "http_request",
    toolArguments: {
      url: invocation.url,
      method: invocation.method ?? "GET",
      headers: invocation.headers ?? {},
      ...(invocation.body ? { body: invocation.body } : {})
    }
  };
}

function parseInvocationJsonResult(params: {
  result: Agent1024RuntimeExecutionResult;
  invocation: MutationInvocation;
  storeId: string;
}): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(params.result.stdout);
  } catch (error) {
    throw new Error(
      `1024 runtime read did not return valid JSON for ${
        params.storeId
      }: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const selected = params.invocation.resultPath
    ? getValueAtPath(isRecord(parsed) ? parsed : {}, params.invocation.resultPath)
    : parsed;

  if (!isRecord(selected)) {
    throw new Error(
      `1024 runtime read returned a non-object payload for ${params.storeId}.`
    );
  }

  return applySnapshotNormalizer(params.invocation.normalizer, selected);
}

function getInvocation(
  executionContext: MutationExecutionContext | undefined,
  storeId: string,
  phase: Agent1024RuntimeExecutionPhase
): MutationInvocation {
  if (!executionContext || executionContext.kind !== "configured_mutation") {
    throw new Error(
      `Store ${storeId} is missing configured protected mutation execution context.`
    );
  }

  if (phase === "write") {
    return executionContext.writeInvocation;
  }

  if (phase === "verify_after") {
    return executionContext.verifyInvocation ?? executionContext.readInvocation;
  }

  return executionContext.readInvocation;
}

export class Agent1024RuntimeInvocationRunner {
  constructor(private readonly options: Agent1024RuntimeAdapterOptions) {}

  async run(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
    phase: Agent1024RuntimeExecutionPhase;
  }): Promise<{
    invocation: MutationInvocation;
    result: Agent1024RuntimeExecutionResult;
  }> {
    const invocation = getInvocation(
      params.executionContext,
      params.storeId,
      params.phase
    );
    const runtimeTool = invocationToRuntimeTool(invocation);
    const idempotencyKey = this.options.idempotencyKeyPrefix
      ? `${this.options.idempotencyKeyPrefix}:${params.phase}`
      : undefined;

    const result = await this.options.client.execute({
      paas: this.options.paas,
      conversationId: this.options.conversationId,
      userMis: this.options.userMis,
      ...runtimeTool,
      invocation,
      safeMutation: {
        planId: this.options.planId,
        phase: params.phase,
        ...(idempotencyKey ? { idempotencyKey } : {})
      },
      traceId: this.options.traceId
    });

    if (result.exitCode !== 0 || result.status === "failed") {
      throw new Error(
        result.stderr.trim() || `1024 runtime exited with code ${result.exitCode}`
      );
    }

    return {
      invocation,
      result
    };
  }
}

export class Agent1024RuntimeReadAdapter implements ReadAdapter {
  private readonly runner: Agent1024RuntimeInvocationRunner;

  constructor(options: Agent1024RuntimeAdapterOptions) {
    this.runner = new Agent1024RuntimeInvocationRunner(options);
  }

  async readCurrentConfig(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
  }): Promise<Record<string, unknown>> {
    const { invocation, result } = await this.runner.run({
      storeId: params.storeId,
      executionContext: params.executionContext,
      phase: "read_before"
    });

    return parseInvocationJsonResult({
      result,
      invocation,
      storeId: params.storeId
    });
  }
}

export class Agent1024RuntimeWriteAdapter implements WriteAdapter {
  private readonly runner: Agent1024RuntimeInvocationRunner;

  constructor(options: Agent1024RuntimeAdapterOptions) {
    this.runner = new Agent1024RuntimeInvocationRunner(options);
  }

  async writeConfig(params: {
    storeId: string;
    payload: Record<string, unknown>;
    executionContext?: MutationExecutionContext;
  }): Promise<WriteAdapterResult> {
    const { result } = await this.runner.run({
      storeId: params.storeId,
      executionContext: params.executionContext,
      phase: "write"
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

export class Agent1024RuntimeVerifyAdapter implements VerifyAdapter {
  private readonly runner: Agent1024RuntimeInvocationRunner;

  constructor(options: Agent1024RuntimeAdapterOptions) {
    this.runner = new Agent1024RuntimeInvocationRunner(options);
  }

  async verifyCurrentConfig(params: {
    storeId: string;
    executionContext?: MutationExecutionContext;
  }): Promise<Record<string, unknown>> {
    const { invocation, result } = await this.runner.run({
      storeId: params.storeId,
      executionContext: params.executionContext,
      phase: "verify_after"
    });
    return parseInvocationJsonResult({
      result,
      invocation,
      storeId: params.storeId
    });
  }
}
