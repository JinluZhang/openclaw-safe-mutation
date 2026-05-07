import { describe, expect, it } from "vitest";

import {
  Agent1024ShellExecClient,
  createAgent1024ShellExecClientFromEnv
} from "../../src/agent1024/shell-exec-client.js";

function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req-1",
      ...(init.headers ?? {})
    },
    ...init
  });
}

describe("Agent1024ShellExecClient", () => {
  it("calls /openapi-v3/shell/exec with api key, command, workdir, timeout, and mis", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        code: "200",
        status: "success",
        message: "执行成功",
        result: {
          command: "echo hello",
          output: "hello\n"
        }
      });
    };
    const client = new Agent1024ShellExecClient({
      apiKey: "rmk_test",
      baseUrl: "https://1024.inf.test.sankuai.com/",
      defaultTimeoutMs: 30000,
      fetchImpl
    });

    const result = await client.execute({
      paas: "wm",
      conversationId: "conv-1",
      userMis: "alice",
      toolName: "bash_execute",
      toolArguments: {
        command: "echo hello",
        workdir: "/tmp/work",
        timeout: 10000
      },
      invocation: {
        kind: "shell",
        command: "echo hello",
        workdir: "/tmp/work"
      },
      safeMutation: {
        phase: "read_before"
      }
    });

    expect(result).toEqual(
      expect.objectContaining({
        executionId: "req-1",
        status: "succeeded",
        exitCode: 0,
        stdout: "hello\n",
        stderr: ""
      })
    );
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(
      "https://1024.inf.test.sankuai.com/openapi-v3/shell/exec"
    );
    expect(calls[0]!.init).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "rmk_test"
        }
      })
    );
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      command: "echo hello",
      workdir: "/tmp/work",
      timeout: 10000,
      mis: "alice"
    });
  });

  it("uses default timeout when request timeout is not set", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        code: "200",
        status: "success",
        result: {
          output: "ok"
        }
      });
    };
    const client = new Agent1024ShellExecClient({
      apiKey: "rmk_test",
      defaultTimeoutMs: 60000,
      fetchImpl
    });

    await client.execute({
      userMis: "alice",
      toolName: "bash_execute",
      toolArguments: {
        command: "echo ok"
      },
      invocation: {
        kind: "shell",
        command: "echo ok"
      }
    });

    expect(body).toEqual({
      command: "echo ok",
      timeout: 60000,
      mis: "alice"
    });
  });

  it("maps api errors to failed runtime results", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          code: "400",
          status: "error",
          message: "command 不能为空",
          result: null
        },
        {
          status: 400,
          statusText: "Bad Request"
        }
      );
    const client = new Agent1024ShellExecClient({
      apiKey: "rmk_test",
      fetchImpl
    });

    const result = await client.execute({
      toolName: "bash_execute",
      toolArguments: {
        command: "echo ok"
      },
      invocation: {
        kind: "shell",
        command: "echo ok"
      }
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        exitCode: 400,
        stdout: "",
        stderr: "command 不能为空"
      })
    );
  });

  it("fails locally when command is missing", async () => {
    const client = new Agent1024ShellExecClient({
      apiKey: "rmk_test",
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });

    const result = await client.execute({
      toolName: "bash_execute",
      toolArguments: {},
      invocation: {
        kind: "shell",
        command: "echo ignored"
      }
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        exitCode: 400,
        stderr: "1024 shell exec requires toolArguments.command."
      })
    );
  });

  it("builds a client from environment variables", async () => {
    const client = createAgent1024ShellExecClientFromEnv({
      AGENT1024_SHELL_EXEC_API_KEY: "rmk_env",
      AGENT1024_SHELL_EXEC_BASE_URL: "https://1024.inf.test.sankuai.com",
      AGENT1024_SHELL_EXEC_TIMEOUT_MS: "120000"
    });

    expect(client).toBeInstanceOf(Agent1024ShellExecClient);
  });

  it("requires api key when building from environment variables", () => {
    expect(() => createAgent1024ShellExecClientFromEnv({})).toThrow(
      "AGENT1024_SHELL_EXEC_API_KEY is required."
    );
  });
});
