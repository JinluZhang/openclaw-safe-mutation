import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProtectedMutationBinding } from "../../src/mutation-registry.js";
import { ProtectedMutationRegistry } from "../../src/mutation-registry.js";
import { resolveProtectedWriteRequest } from "../../src/protected-write-request.js";

const tempDirs: string[] = [];

async function createMockSkillFixture(): Promise<{
  rootDir: string;
  scriptDir: string;
  scriptPath: string;
  stateFilePath: string;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "safe-mutation-"));
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
  await writeFile(scriptPath, "# mock script\n", "utf8");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
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
    write_parser.add_argument("--tier-1-threshold", type=float)
    write_parser.add_argument("--tier-1-discount", type=float)
    write_parser.add_argument("--remark")

    args = parser.parse_args()
    state = json.loads(args.state_file.read_text(encoding="utf-8"))
    record = dict(state["pois"][args.poiid])
    record["poiid"] = args.poiid

    if args.command == "read":
        payload = dict(record)
        payload["full_reduction_tiers"] = build_tiers(record)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(json.dumps({"status": "unsupported"}, ensure_ascii=False))
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
            tier_1_threshold: 27,
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
            version: 7,
            created_at: "2026-04-21T20:00:00",
            updated_at: "2026-04-23T23:00:00"
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
    scriptDir,
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
          fieldId: "tier_1_threshold",
          flag: "--tier-1-threshold",
          label: "第一档门槛",
          valueType: "decimal",
          readPath: "tier_1_threshold"
        },
        {
          fieldId: "tier_1_discount",
          flag: "--tier-1-discount",
          label: "第一档优惠",
          valueType: "decimal",
          readPath: "tier_1_discount"
        },
        {
          fieldId: "remark",
          flag: "--remark",
          label: "备注",
          valueType: "string",
          readPath: "remark"
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
      paths: ["updated_at", "version", "promotion.full_reduction_tiers"]
    }
  };
}

describe("resolveProtectedWriteRequest", () => {
  it("normalizes absolute mock full-reduction exec writes into protected requests", async () => {
    const fixture = await createMockSkillFixture();
    const registry = new ProtectedMutationRegistry([buildMockBinding()]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command: `python3 ${fixture.scriptPath} write --poiid 10001 --tier-1-threshold 28 --tier-1-discount 15 --format json`
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request).toMatchObject({
      toolName: "mock-full-reduction-config",
      storeId: "10001",
      source: "exec",
      executionContext: {
        kind: "configured_mutation",
        bindingId: "mock-full-reduction.exec",
        readInvocation: expect.objectContaining({
          kind: "shell",
          normalizer: "mockFullReductionRead"
        }),
        writeInvocation: expect.objectContaining({
          kind: "shell"
        })
      }
    });
    expect(resolution?.request?.beforeSnapshot?.tier_1_threshold).toBe(27);
    expect(
      resolution?.request?.beforeSnapshot?.promotion as Record<string, unknown>
    ).toMatchObject({
      full_reduction_tiers: [
        { threshold: 27, reduction: 15 },
        { threshold: 45, reduction: 25 },
        { threshold: 60, reduction: 35 }
      ]
    });
    expect(resolution?.request?.payload.tier_1_threshold).toBe(28);
    expect(
      (resolution?.request?.payload.promotion as Record<string, unknown>)
        .full_reduction_tiers
    ).toEqual([
      { threshold: 27, reduction: 15 },
      { threshold: 45, reduction: 25 },
      { threshold: 60, reduction: 35 }
    ]);
  });

  it("supports basename script commands when exec workdir points at the script directory", async () => {
    const fixture = await createMockSkillFixture();
    const registry = new ProtectedMutationRegistry([buildMockBinding()]);

    const resolution = await resolveProtectedWriteRequest({
      toolName: "exec",
      params: {
        command:
          'python3 mock_full_reduction_cli.py write --poiid 10001 --remark "phase 1 dry run" --format json',
        workdir: fixture.scriptDir
      },
      registry
    });

    expect(resolution?.error).toBeUndefined();
    expect(resolution?.request?.storeId).toBe("10001");
    expect(resolution?.request?.payload.remark).toBe("phase 1 dry run");
  });
});
