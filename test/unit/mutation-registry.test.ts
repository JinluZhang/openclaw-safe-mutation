import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  matchCliCommand,
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

function buildCliBinding(
  overrides: Partial<ProtectedMutationBinding> = {}
): ProtectedMutationBinding {
  return {
    id: "shop.cli",
    protectedToolName: "shop-settings",
    match: {
      kind: "cli",
      toolName: "exec",
      commandPrefix: ["shopctl", "settings", "set"],
      positionals: [
        {
          variableName: "storeId"
        }
      ],
      resourceIdTemplate: "{{storeId}}",
      mutableFlagsFromSchema: true,
      ignoredFlags: ["--format"]
    },
    fieldSchema: {
      kind: "inline",
      fields: shopFieldSchema
    },
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
  it("returns explicit matched, not_matched, and suspicious states for generic CLI matching", () => {
    const match = {
      kind: "cli",
      toolName: "exec",
      commandPrefix: ["shopctl", "settings", "set"],
      resourceIdTemplate: "{{flag:--store-id}}",
      mutableFlags: {
        "--shop-name": "shop_name"
      }
    } as const;

    expect(
      matchCliCommand({
        bindingId: "shop.cli",
        match,
        command: "shopctl settings set --store-id 10001 --shop-name Fresh"
      }).status
    ).toBe("matched");

    expect(
      matchCliCommand({
        bindingId: "shop.cli",
        match,
        command: "otherctl settings set --store-id 10001 --shop-name Fresh"
      }).status
    ).toBe("not_matched");

    expect(
      matchCliCommand({
        bindingId: "shop.cli",
        match,
        command: "shopctl settings set --store-id 10001 --shop-name Fresh && true"
      }).status
    ).toBe("suspicious");
  });

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

  it("matches generic CLI commands with positionals, quoted values, and schema-derived flags", async () => {
    const registry = new ProtectedMutationRegistry([buildCliBinding()]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command:
          'shopctl settings set store-1 --shop-name "Fresh Market" --enabled=false --min-order-price 25 --format json'
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
        name: "Fresh Market"
      },
      enabled: false,
      delivery: {
        min_order_price: 25
      }
    });
  });

  it("supports escaped CLI values and resource IDs rendered from flag placeholders", async () => {
    const registry = new ProtectedMutationRegistry([
      buildCliBinding({
        match: {
          kind: "cli",
          toolName: "exec",
          commandPrefix: ["shopctl", "settings", "set"],
          resourceIdTemplate: "shop:{{flag:--store-id}}",
          mutableFlags: {
            "--shop-name": "shop_name"
          }
        }
      })
    ]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command:
          "shopctl settings set --store-id=10001 --shop-name Fresh\\ Market"
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request?.storeId).toBe("shop:10001");
    expect(resolution?.request?.payload).toMatchObject({
      shop: {
        name: "Fresh Market"
      }
    });
  });

  it("leaves unrelated generic CLI commands unmatched", async () => {
    const registry = new ProtectedMutationRegistry([buildCliBinding()]);

    await expect(
      registry.match({
        toolName: "exec",
        params: {
          command: "otherctl settings set store-1 --shop-name Fresh"
        }
      })
    ).resolves.toEqual({});
  });

  it("fails closed for suspicious generic CLI commands after a protected prefix", async () => {
    const registry = new ProtectedMutationRegistry([buildCliBinding()]);
    const suspiciousCommands = [
      "shopctl settings set store-1 --shop-name Fresh && echo done",
      "shopctl settings set store-1 --shop-name Fresh; echo done",
      "shopctl settings set store-1 --shop-name Fresh | cat",
      "shopctl settings set store-1 --shop-name `whoami`",
      "shopctl settings set store-1 --shop-name $(whoami)",
      "shopctl settings set store-1 <<EOF",
      'bash -lc "shopctl settings set store-1 --shop-name Fresh"',
      "shopctl settings set store-1 --shop-name"
    ];

    for (const command of suspiciousCommands) {
      await expect(
        registry.match({
          toolName: "exec",
          params: {
            command
          }
        })
      ).resolves.toMatchObject({
        error: expect.stringMatching(/Protected CLI binding shop\.cli/u)
      });
    }
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
