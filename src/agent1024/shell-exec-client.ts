import type {
  Agent1024RuntimeExecutionClient,
  Agent1024RuntimeExecutionRequest,
  Agent1024RuntimeExecutionResult
} from "./runtime-executor.js";

export interface Agent1024ShellExecClientOptions {
  apiKey: string;
  baseUrl?: string;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface Agent1024ShellExecResponse {
  code?: string;
  status?: string;
  message?: string;
  result?: {
    command?: string;
    output?: string;
  } | null;
}

const DEFAULT_BASE_URL = "https://1024.inf.test.sankuai.com";
const SHELL_EXEC_PATH = "/openapi-v3/shell/exec";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getCommand(request: Agent1024RuntimeExecutionRequest): string | undefined {
  return getString(request.toolArguments.command);
}

function getWorkdir(request: Agent1024RuntimeExecutionRequest): string | undefined {
  return getString(request.toolArguments.workdir);
}

function getTimeout(
  request: Agent1024RuntimeExecutionRequest,
  defaultTimeoutMs: number | undefined
): number | undefined {
  return getNumber(request.toolArguments.timeout) ?? defaultTimeoutMs;
}

function parseShellExecResponse(value: unknown): Agent1024ShellExecResponse {
  if (!isRecord(value)) {
    throw new Error("1024 shell exec response is not an object.");
  }

  const result = value.result;

  return {
    code: getString(value.code),
    status: getString(value.status),
    message: getString(value.message),
    result:
      result === null || result === undefined
        ? null
        : {
            command: isRecord(result) ? getString(result.command) : undefined,
            output: isRecord(result) ? getString(result.output) : undefined
          }
  };
}

function buildErrorMessage(params: {
  httpStatus: number;
  httpStatusText: string;
  response?: Agent1024ShellExecResponse;
  responseText: string;
}): string {
  const response = params.response;
  const apiMessage = response?.message ?? response?.result?.output;

  return (
    apiMessage ||
    params.responseText ||
    `${params.httpStatus} ${params.httpStatusText}`.trim()
  );
}

function toExitCode(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

export class Agent1024ShellExecClient
  implements Agent1024RuntimeExecutionClient
{
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Agent1024ShellExecClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(
    request: Agent1024RuntimeExecutionRequest
  ): Promise<Agent1024RuntimeExecutionResult> {
    const command = getCommand(request);
    const startedAt = Date.now();

    if (!command) {
      return {
        status: "failed",
        exitCode: 400,
        stdout: "",
        stderr: "1024 shell exec requires toolArguments.command.",
        startedAt,
        finishedAt: Date.now()
      };
    }

    const body: Record<string, unknown> = {
      command,
      ...(getWorkdir(request) ? { workdir: getWorkdir(request) } : {}),
      ...(getTimeout(request, this.options.defaultTimeoutMs)
        ? { timeout: getTimeout(request, this.options.defaultTimeoutMs) }
        : {}),
      ...(request.userMis ? { mis: request.userMis } : {})
    };

    const response = await this.fetchImpl(`${this.baseUrl}${SHELL_EXEC_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.options.apiKey
      },
      body: JSON.stringify(body)
    });
    const responseText = await response.text();
    let parsed: Agent1024ShellExecResponse | undefined;

    try {
      parsed = parseShellExecResponse(JSON.parse(responseText));
    } catch (error) {
      if (response.ok) {
        throw error;
      }
    }

    const succeeded =
      response.ok && parsed?.code === "200" && parsed.status === "success";
    const finishedAt = Date.now();

    return {
      executionId: response.headers.get("x-request-id") ?? undefined,
      status: succeeded ? "succeeded" : "failed",
      exitCode: succeeded ? 0 : toExitCode(parsed?.code, response.status || 1),
      stdout: parsed?.result?.output ?? "",
      stderr: succeeded
        ? ""
        : buildErrorMessage({
            httpStatus: response.status,
            httpStatusText: response.statusText,
            response: parsed,
            responseText
          }),
      startedAt,
      finishedAt
    };
  }
}

export function createAgent1024ShellExecClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Agent1024ShellExecClient {
  const apiKey = env.AGENT1024_SHELL_EXEC_API_KEY;

  if (!apiKey) {
    throw new Error("AGENT1024_SHELL_EXEC_API_KEY is required.");
  }

  const defaultTimeoutMs = env.AGENT1024_SHELL_EXEC_TIMEOUT_MS
    ? Number(env.AGENT1024_SHELL_EXEC_TIMEOUT_MS)
    : undefined;

  return new Agent1024ShellExecClient({
    apiKey,
    baseUrl: env.AGENT1024_SHELL_EXEC_BASE_URL,
    defaultTimeoutMs:
      defaultTimeoutMs !== undefined && Number.isFinite(defaultTimeoutMs)
        ? defaultTimeoutMs
        : undefined
  });
}
