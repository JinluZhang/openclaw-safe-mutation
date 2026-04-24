---
name: mock-full-reduction-config
description: Mock full-reduction promotion configuration skill for OpenClaw Safe Mutation validation. Use when the user asks to view or modify demo store full-reduction settings, promotion thresholds, discounts, budget, activity time, stacking switches, or remarks in the mock data store.
---

# Mock Full Reduction Config

This skill is a demo write skill for validating the `safe-mutation` plugin. It intentionally writes through a CLI so the platform hook can intercept the exact write command, freeze the payload, ask the user to confirm, and execute the frozen plan after approval.

## Critical Rules

- Do not edit `data/mock_full_reduction_state.json` directly.
- Use `scripts/mock_full_reduction_cli.py` for both reads and writes.
- For writes, call the CLI `write` subcommand with the minimum fields requested by the user. The safe-mutation plugin will read the current state and freeze the complete payload.
- After a write is blocked for approval, do not claim the change has been applied. The user must reply `确认` to execute or `取消` to abandon.
- Use `--poiid` as the store ID. The seeded demo stores are `10001` and `10002`.

## Locate The CLI

In a normal OpenClaw workspace, this skill is installed at:

```bash
skills/mock-full-reduction-config
```

Use this helper pattern when running commands:

```bash
SKILL_DIR="${OPENCLAW_WORKSPACE:-$PWD}/skills/mock-full-reduction-config"
python3 "$SKILL_DIR/scripts/mock_full_reduction_cli.py" --help
```

If the current working directory is already the skill directory, use:

```bash
python3 scripts/mock_full_reduction_cli.py --help
```

## Read Current Config

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py read --poiid 10001 --format json
```

The read output includes both scalar tier fields such as `tier_1_threshold` and a derived `full_reduction_tiers` list for display.

## Write Config

Examples:

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --poiid 10001 --tier-1-threshold 20 --tier-1-discount 15 --format json
```

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --poiid 10001 --budget-limit 800 --remark "weekend budget adjustment" --format json
```

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --poiid 10001 --activity-status disabled --format json
```

Supported boolean values: `1`, `0`, `true`, `false`, `yes`, `no`, `on`, `off`.

## Inspect Field Definitions

Human-readable CLI help:

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --help
```

Machine-readable schema:

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py schema --format json
```

The safe-mutation plugin currently maps write flags to platform field IDs through its `ParameterCatalog` and `protectedMutations` binding.
