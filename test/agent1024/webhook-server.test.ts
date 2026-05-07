import { describe, expect, it } from "vitest";

import type { ReadAdapter } from "../../src/core/adapters/read-adapter.js";
import type { VerifyAdapter } from "../../src/core/adapters/verify-adapter.js";
import type { WriteAdapter } from "../../src/core/adapters/write-adapter.js";
import { ProtectedMutationRegistry } from "../../src/core/mutation-registry.js";
import { InMemoryAgent1024ApprovalNotifier } from "../../src/agent1024/notifier.js";
import {
  startAgent1024WebhookServer,
  type Agent1024WebhookDependencies
} from "../../src/agent1024/webhook-server.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";

class StaticReadAdapter implements ReadAdapter {
  async readCurrentConfig(): Promise<Record<string, unknown>> {
    return {};
  }
}

class NoopWriteAdapter implements WriteAdapter {
  async writeConfig(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }
}

class StaticVerifyAdapter implements VerifyAdapter {
  async verifyCurrentConfig(): Promise<Record<string, unknown>> {
    return {};
  }
}

function buildDependencies(): Agent1024WebhookDependencies {
  return {
    planStore: new InMemoryMutationPlanStore(),
    readAdapter: new StaticReadAdapter(),
    writeAdapter: new NoopWriteAdapter(),
    verifyAdapter: new StaticVerifyAdapter(),
    notifier: new InMemoryAgent1024ApprovalNotifier(),
    protectedMutationRegistry: new ProtectedMutationRegistry([])
  };
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = await startAgent1024WebhookServer(buildDependencies(), {
    host: "127.0.0.1"
  });

  try {
    return await callback(`http://127.0.0.1:${server.port()}`);
  } finally {
    await server.close();
  }
}

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

describe("agent1024 webhook server", () => {
  it("serves health checks", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhook/safe-mutation/healthz`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });
  });

  it("routes PRE_TOOL_USE callbacks to the pre-tool-use handler", async () => {
    await withServer(async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        "/webhook/safe-mutation/pre-tool-use",
        {
          event: "PRE_TOOL_USE",
          paas: "wm",
          conversationId: "conv-1",
          userMis: "alice",
          toolName: "bash_execute",
          toolCallId: "call-1",
          toolArguments: {
            command: "echo hello"
          },
          timestamp: 100
        }
      );

      expect(response).toEqual({
        status: 200,
        body: {
          decision: "allow"
        }
      });
    });
  });

  it("routes USER_MESSAGE_RECEIVED callbacks to the user-message handler", async () => {
    await withServer(async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        "/webhook/safe-mutation/user-message-received",
        {
          event: "USER_MESSAGE_RECEIVED",
          paas: "wm",
          conversationId: "conv-1",
          userMis: "alice",
          messageType: "SINGLE_MESSAGE",
          messageContent: "你好",
          contentItems: [
            {
              type: "TEXT",
              content: "你好"
            }
          ],
          timestamp: 100
        }
      );

      expect(response).toEqual({
        status: 200,
        body: {
          decision: "allow"
        }
      });
    });
  });

  it("blocks when a callback is posted to the wrong event route", async () => {
    await withServer(async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        "/webhook/safe-mutation/pre-tool-use",
        {
          event: "USER_MESSAGE_RECEIVED",
          paas: "wm",
          conversationId: "conv-1",
          userMis: "alice",
          messageContent: "确认",
          timestamp: 100
        }
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          decision: "block",
          reason: expect.stringContaining("Expected webhook event PRE_TOOL_USE")
        })
      );
    });
  });
});
