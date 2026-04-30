import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProtectedMutationRegistry,
  type ProtectedMutationBinding
} from "../../src/mutation-registry.js";
import { resolveProtectedWriteRequest } from "../../src/protected-write-request.js";
import { shopFieldSchema } from "../helpers/generic-schema.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

function nodePrintJsonCommand(value: unknown): string[] {
  return [
    "node",
    "-e",
    `console.log(JSON.stringify(${JSON.stringify(value)}))`
  ];
}

function buildExecBinding(fieldSchema: ProtectedMutationBinding["fieldSchema"]): ProtectedMutationBinding {
  return {
    id: "shop.exec",
    protectedToolName: "shop-settings",
    match: {
      kind: "exec",
      toolName: "exec",
      pythonExecutable: true,
      scriptBasename: "shop_cli.py",
      writeSubcommand: "write",
      readSubcommand: "read",
      resourceFlag: "--poiid",
      mutableFlagsFromSchema: true,
      ignoredWriteFlags: ["--format"]
    },
    fieldSchema,
    read: {
      kind: "shell",
      commandTokens: nodePrintJsonCommand({
        shop: {
          name: "Old Shop"
        },
        enabled: true,
        delivery: {
          min_order_price: 20
        }
      })
    }
  };
}

function buildDirectToolBinding(
  overrides: Partial<ProtectedMutationBinding> = {}
): ProtectedMutationBinding {
  return {
    id: "shop.tool",
    protectedToolName: "shop-settings",
    match: {
      kind: "tool",
      toolName: "shop-settings",
      resourceParamPath: "storeId",
      payloadParamPath: "payload"
    },
    fieldSchema: {
      kind: "inline",
      fields: shopFieldSchema
    },
    read: {
      kind: "shell",
      commandTokens: nodePrintJsonCommand({})
    },
    write: {
      kind: "shell",
      commandTokens: nodePrintJsonCommand({ ok: true })
    },
    ...overrides
  };
}

async function listenWithSchema(schemaBody: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(schemaBody));
  });
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test HTTP server.");
  }

  return `http://127.0.0.1:${address.port}/schema`;
}

describe("ProtectedMutationRegistry schema-backed matching", () => {
  it("matches exec writes with an inline schema and schema-derived flags", async () => {
    const registry = new ProtectedMutationRegistry([
      buildExecBinding({
        kind: "inline",
        fields: shopFieldSchema
      })
    ]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command:
          "python3 /tmp/shop_cli.py write --poiid store-1 --shop-name Fresh --enabled false --format json"
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request).toMatchObject({
      toolName: "shop-settings",
      storeId: "store-1",
      source: "exec"
    });
    expect(resolution?.request?.payload).toMatchObject({
      shop: {
        name: "Fresh"
      },
      enabled: false
    });
    expect(resolution?.request?.fieldSchemaHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("discovers a shell schema before matching exec mutable flags", async () => {
    const registry = new ProtectedMutationRegistry([
      buildExecBinding({
        kind: "shell",
        commandTokens: nodePrintJsonCommand({
          fields: shopFieldSchema
        }),
        resultPath: "fields"
      })
    ]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command:
          "python3 /tmp/shop_cli.py write --poiid store-1 --min-order-price 25"
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request?.payload).toMatchObject({
      delivery: {
        min_order_price: 25
      }
    });
  });

  it("discovers an HTTP schema for direct tool matching", async () => {
    const schemaUrl = await listenWithSchema({
      fields: shopFieldSchema
    });
    const registry = new ProtectedMutationRegistry([
      buildDirectToolBinding({
        fieldSchema: {
          kind: "http",
          url: schemaUrl,
          resultPath: "fields"
        }
      })
    ]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "shop-settings",
      params: {
        storeId: "store-1",
        payload: {
          shop: {
            name: "Fresh"
          },
          enabled: true,
          delivery: {
            min_order_price: 20
          }
        }
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request?.source).toBe("tool");
    expect(resolution?.request?.fieldSchema).toEqual(shopFieldSchema);
  });

  it("fails closed for unknown flags, missing resource IDs, and invalid typed values", async () => {
    const registry = new ProtectedMutationRegistry([
      buildExecBinding({
        kind: "inline",
        fields: shopFieldSchema
      })
    ]);

    await expect(
      registry.match({
        toolName: "exec",
        params: {
          command: "python3 /tmp/shop_cli.py write --poiid store-1 --unknown value"
        }
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining("unsupported flag --unknown")
    });

    await expect(
      registry.match({
        toolName: "exec",
        params: {
          command: "python3 /tmp/shop_cli.py write --shop-name Fresh"
        }
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining("missing required --poiid")
    });

    await expect(
      registry.match({
        toolName: "exec",
        params: {
          command:
            "python3 /tmp/shop_cli.py write --poiid store-1 --enabled maybe"
        }
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining("Unsupported boolean value")
    });
  });

  it("fails closed when a direct tool binding omits write invocation", async () => {
    const registry = new ProtectedMutationRegistry([
      buildDirectToolBinding({
        write: undefined
      })
    ]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "shop-settings",
      params: {
        storeId: "store-1",
        payload: {
          shop: {
            name: "Fresh"
          }
        }
      },
      registry
    });

    expect(resolution?.error).toContain(
      "must declare a write invocation for direct tool execution"
    );
  });
});
