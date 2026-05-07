import type {
  Agent1024RuntimeExecutionClient,
  Agent1024RuntimeExecutionRequest,
  Agent1024RuntimeExecutionResult
} from "./runtime-executor.js";

export type MockRuntimeCommandHandler = (
  request: Agent1024RuntimeExecutionRequest
) =>
  | Agent1024RuntimeExecutionResult
  | Promise<Agent1024RuntimeExecutionResult>;

export class MockAgent1024RuntimeExecutionClient
  implements Agent1024RuntimeExecutionClient
{
  readonly requests: Agent1024RuntimeExecutionRequest[] = [];
  private readonly commandHandlers = new Map<string, MockRuntimeCommandHandler>();
  private readonly idempotencyResults = new Map<
    string,
    Agent1024RuntimeExecutionResult
  >();

  registerCommand(
    command: string,
    handler: MockRuntimeCommandHandler
  ): void {
    this.commandHandlers.set(command, handler);
  }

  async execute(
    request: Agent1024RuntimeExecutionRequest
  ): Promise<Agent1024RuntimeExecutionResult> {
    this.requests.push(structuredClone(request));

    const idempotencyKey = request.safeMutation?.idempotencyKey;

    if (idempotencyKey && this.idempotencyResults.has(idempotencyKey)) {
      return structuredClone(this.idempotencyResults.get(idempotencyKey)!);
    }

    const command =
      typeof request.toolArguments.command === "string"
        ? request.toolArguments.command
        : undefined;
    const handler = command ? this.commandHandlers.get(command) : undefined;
    const result = handler
      ? await handler(request)
      : {
          executionId: `exec_${this.requests.length}`,
          status: "failed" as const,
          exitCode: 127,
          stdout: "",
          stderr: command
            ? `No mock runtime handler registered for command: ${command}`
            : `No mock runtime handler registered for tool: ${request.toolName}`
        };

    if (idempotencyKey) {
      this.idempotencyResults.set(idempotencyKey, structuredClone(result));
    }

    return result;
  }
}
