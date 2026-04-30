import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApprovalPrincipal } from "../../src/approval-principal.js";
import { runMutateApproveCommand } from "../../src/commands/mutate-approve.js";
import {
  ProtectedMutationRegistry,
  type ProtectedMutationBinding
} from "../../src/mutation-registry.js";
import { ensureProtectedWritePlan } from "../../src/protected-write-plan.js";
import { resolveProtectedWriteRequest } from "../../src/protected-write-request.js";
import {
  ToolReadAdapter,
  ToolVerifyAdapter,
  ToolWriteAdapter
} from "../../src/tool-backed-adapters.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";

const tempDirs: string[] = [];

function buildMockBinding(): ProtectedMutationBinding {
  return {
    id: "mock-full-reduction.exec",
    protectedToolName: "mock-full-reduction-config",
    match: {
      kind: "exec",
      toolName: "exec",
      pythonExecutable: true,
      scriptBasename: "mock_full_reduction_cli.py",
      writeSubcommand: "write",
      readSubcommand: "read",
      preSubcommandFlags: {
        "--state-file": {
          variableName: "stateFilePath",
          pathValue: true,
          defaultValue: {
            kind: "relativeToScriptDir",
            path: "../data/mock_full_reduction_state.json"
          }
        }
      },
      ignoredWriteFlags: ["--format", "--state-file"],
      resourceFlag: "--poiid",
      mutableFlagsFromSchema: true
    },
    fieldSchema: {
      kind: "inline",
      fields: [
        {
          fieldId: "tier_1_discount",
          flag: "--tier-1-discount",
          label: "第一档优惠",
          valueType: "decimal",
          readPath: "tier_1_discount"
        }
      ]
    },
    read: {
      kind: "shell",
      commandTokens: [
        "{{envAssignmentTokens}}",
        "{{pythonToken}}",
        "{{pythonOptionTokens}}",
        "{{scriptPath}}",
        "--state-file",
        "{{stateFilePath}}",
        "read",
        "--poiid",
        "{{resourceId}}",
        "--format",
        "json"
      ],
      normalizer: "mockFullReductionRead"
    },
    compareNormalizer: {
      kind: "stripFields",
      paths: [
        "version",
        "updated_at",
        "promotion.full_reduction_tiers",
        "full_reduction_tiers"
      ]
    }
  };
}

async function createMockSkillFixture(): Promise<{
  rootDir: string;
  scriptPath: string;
  stateFilePath: string;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "safe-mutation-tool-"));
  tempDirs.push(rootDir);
  const skillDir = path.join(rootDir, "skills", "mock-full-reduction-config");
  const scriptDir = path.join(skillDir, "scripts");
  const dataDir = path.join(skillDir, "data");
  const scriptPath = path.join(scriptDir, "mock_full_reduction_cli.py");
  const stateFilePath = path.join(dataDir, "mock_full_reduction_state.json");

  await mkdir(scriptDir, {
    recursive: true
  });
  await mkdir(dataDir, {
    recursive: true
  });
  await writeFile(
    scriptPath,
    `#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def build_tiers(record):
    return [
        {"threshold": record["tier_1_threshold"], "discount": record["tier_1_discount"]},
        {"threshold": record["tier_2_threshold"], "discount": record["tier_2_discount"]},
        {"threshold": record["tier_3_threshold"], "discount": record["tier_3_discount"]},
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-file", type=Path, required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    read_parser = subparsers.add_parser("read")
    read_parser.add_argument("--poiid", required=True)
    read_parser.add_argument("--format", choices=("json", "pretty"), default="json")

    write_parser = subparsers.add_parser("write")
    write_parser.add_argument("--poiid", required=True)
    write_parser.add_argument("--format", choices=("json", "pretty"), default="json")
    write_parser.add_argument("--tier-1-discount", type=float)

    args = parser.parse_args()
    state = json.loads(args.state_file.read_text(encoding="utf-8"))
    record = dict(state["pois"][args.poiid])

    if args.command == "read":
        payload = dict(record)
        payload["poiid"] = args.poiid
        payload["full_reduction_tiers"] = build_tiers(record)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if args.tier_1_discount is not None:
        record["tier_1_discount"] = args.tier_1_discount
    record["version"] = int(record.get("version", 0)) + 1
    record["updated_at"] = "2026-04-24T01:00:00"
    state["pois"][args.poiid] = record
    args.state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
    payload = dict(record)
    payload["poiid"] = args.poiid
    payload["full_reduction_tiers"] = build_tiers(record)
    print(json.dumps({"record": payload}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,
    "utf8"
  );
  await writeFile(
    stateFilePath,
    `${JSON.stringify(
      {
        schema_version: 1,
        pois: {
          "10001": {
            activity_name: "weekday_lunch_full_reduction",
            activity_status: "enabled",
            start_time: "2026-04-21T10:00",
            end_time: "2026-05-21T22:00",
            weekday_mask: "1111100",
            min_order_price: 18,
            delivery_fee_discount: 2,
            tier_1_threshold: 22,
            tier_1_discount: 15,
            tier_2_threshold: 45,
            tier_2_discount: 25,
            tier_3_threshold: 60,
            tier_3_discount: 35,
            stack_with_coupon: true,
            stack_with_membership: false,
            new_customer_only: false,
            vip_only: false,
            budget_limit: 1200,
            remark: "seeded_for_safe_mutation_tests",
            version: 10,
            created_at: "2026-04-21T20:00:00",
            updated_at: "2026-04-24T00:48:00"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    rootDir,
    scriptPath,
    stateFilePath
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dirPath) =>
      rm(dirPath, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("tool-backed workflow", () => {
  it("creates and executes a plan through the real CLI read/write path", async () => {
    const fixture = await createMockSkillFixture();
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new ToolReadAdapter();
    const verifyAdapter = new ToolVerifyAdapter();
    const writeAdapter = new ToolWriteAdapter();
    const registry = new ProtectedMutationRegistry([buildMockBinding()]);
    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command: `python3 ${fixture.scriptPath} --state-file ${fixture.stateFilePath} write --poiid 10001 --tier-1-discount 14 --format json`
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request?.source).toBe("exec");
    expect(resolution?.request?.payload.tier_1_discount).toBe(14);

    const result = await ensureProtectedWritePlan(
      {
        planStore,
        readAdapter,
        now: () => 100,
        planIdFactory: () => "plan-tool-success"
      },
      {
        storeId: "10001",
        writePayload: resolution?.request?.payload ?? {},
        fieldSchema: resolution?.request?.fieldSchema ?? [],
        fieldSchemaHash: resolution?.request?.fieldSchemaHash,
        executionContext: resolution?.request?.executionContext,
        requestedBy: "alice",
        approvalChannel: "feishu",
        approvalSenderId: "alice",
        approvalAccountId: "default",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        }),
        sessionKey: "session-1",
        channel: "feishu"
      }
    );

    expect(result.plan.beforeSnapshot.tier_1_discount).toBe(15);

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 200
      },
      {
        planId: "plan-tool-success",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("succeeded");
    expect(finalPlan.result).toEqual(
      expect.objectContaining({
        writeSucceeded: true,
        verifySucceeded: true,
        verifySnapshot: expect.objectContaining({
          tier_1_discount: 14,
          version: 11,
          updated_at: "2026-04-24T01:00:00"
        })
      })
    );

    const state = JSON.parse(
      await readFile(fixture.stateFilePath, "utf8")
    ) as {
      pois: Record<string, Record<string, unknown>>;
    };

    expect(state.pois["10001"]?.tier_1_discount).toBe(14);
    expect(state.pois["10001"]?.version).toBe(11);
  });
});
