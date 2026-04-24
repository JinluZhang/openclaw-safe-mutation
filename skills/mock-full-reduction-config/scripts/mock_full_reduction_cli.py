#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


FIELD_DEFINITIONS: list[dict[str, Any]] = [
    {
        "flag": "--activity-name",
        "fieldId": "activity_name",
        "type": "string",
        "help": "Activity display name.",
    },
    {
        "flag": "--activity-status",
        "fieldId": "activity_status",
        "type": "enum",
        "choices": ["enabled", "disabled"],
        "help": "Whether the activity is enabled or disabled.",
    },
    {
        "flag": "--start-time",
        "fieldId": "start_time",
        "type": "datetime",
        "help": "Activity start datetime, for example 2026-04-21T10:00.",
    },
    {
        "flag": "--end-time",
        "fieldId": "end_time",
        "type": "datetime",
        "help": "Activity end datetime, for example 2026-05-21T22:00.",
    },
    {
        "flag": "--weekday-mask",
        "fieldId": "weekday_mask",
        "type": "string",
        "help": "Weekday mask as seven 0/1 digits, Monday first.",
    },
    {
        "flag": "--min-order-price",
        "fieldId": "min_order_price",
        "type": "decimal",
        "help": "Minimum order amount.",
    },
    {
        "flag": "--delivery-fee-discount",
        "fieldId": "delivery_fee_discount",
        "type": "decimal",
        "help": "Delivery fee discount amount.",
    },
    {
        "flag": "--tier-1-threshold",
        "fieldId": "tier_1_threshold",
        "type": "decimal",
        "help": "Tier 1 threshold amount.",
    },
    {
        "flag": "--tier-1-discount",
        "fieldId": "tier_1_discount",
        "type": "decimal",
        "help": "Tier 1 discount amount.",
    },
    {
        "flag": "--tier-2-threshold",
        "fieldId": "tier_2_threshold",
        "type": "decimal",
        "help": "Tier 2 threshold amount.",
    },
    {
        "flag": "--tier-2-discount",
        "fieldId": "tier_2_discount",
        "type": "decimal",
        "help": "Tier 2 discount amount.",
    },
    {
        "flag": "--tier-3-threshold",
        "fieldId": "tier_3_threshold",
        "type": "decimal",
        "help": "Tier 3 threshold amount.",
    },
    {
        "flag": "--tier-3-discount",
        "fieldId": "tier_3_discount",
        "type": "decimal",
        "help": "Tier 3 discount amount.",
    },
    {
        "flag": "--stack-with-coupon",
        "fieldId": "stack_with_coupon",
        "type": "boolean",
        "help": "Whether coupons can be stacked.",
    },
    {
        "flag": "--stack-with-membership",
        "fieldId": "stack_with_membership",
        "type": "boolean",
        "help": "Whether membership discounts can be stacked.",
    },
    {
        "flag": "--new-customer-only",
        "fieldId": "new_customer_only",
        "type": "boolean",
        "help": "Whether the activity is only for new customers.",
    },
    {
        "flag": "--vip-only",
        "fieldId": "vip_only",
        "type": "boolean",
        "help": "Whether the activity is only for VIP users.",
    },
    {
        "flag": "--budget-limit",
        "fieldId": "budget_limit",
        "type": "decimal",
        "help": "Campaign budget limit.",
    },
    {
        "flag": "--remark",
        "fieldId": "remark",
        "type": "string",
        "help": "Operator remark.",
    },
]


def default_state_path() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "mock_full_reduction_state.json"


def parse_bool(raw_value: str) -> bool:
    normalized = raw_value.strip().lower()

    if normalized in {"1", "true", "yes", "y", "on"}:
        return True

    if normalized in {"0", "false", "no", "n", "off"}:
        return False

    raise argparse.ArgumentTypeError(
        f"unsupported boolean value {raw_value!r}; use true/false, yes/no, on/off, or 1/0"
    )


def parse_decimal(raw_value: str) -> int | float:
    value = float(raw_value)
    return int(value) if value.is_integer() else value


def load_state(state_file: Path) -> dict[str, Any]:
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"state file does not exist: {state_file}") from None

    if not isinstance(state, dict) or not isinstance(state.get("pois"), dict):
        raise SystemExit(f"state file has invalid shape: {state_file}")

    return state


def save_state(state_file: Path, state: dict[str, Any]) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def get_record(state: dict[str, Any], poiid: str) -> dict[str, Any]:
    pois = state.get("pois")

    if not isinstance(pois, dict) or poiid not in pois:
        raise SystemExit(f"poiid {poiid} does not exist")

    record = pois[poiid]

    if not isinstance(record, dict):
        raise SystemExit(f"poiid {poiid} has invalid record shape")

    return record


def build_tiers(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "threshold": record["tier_1_threshold"],
            "discount": record["tier_1_discount"],
        },
        {
            "threshold": record["tier_2_threshold"],
            "discount": record["tier_2_discount"],
        },
        {
            "threshold": record["tier_3_threshold"],
            "discount": record["tier_3_discount"],
        },
    ]


def build_payload(poiid: str, record: dict[str, Any]) -> dict[str, Any]:
    payload = dict(record)
    payload["poiid"] = poiid
    payload["full_reduction_tiers"] = build_tiers(record)
    return payload


def print_payload(payload: dict[str, Any], output_format: str) -> None:
    if output_format == "pretty":
        for key, value in payload.items():
            print(f"{key}: {value}")
        return

    print(json.dumps(payload, ensure_ascii=False, indent=2))


def field_arg_type(field_type: str) -> Callable[[str], Any]:
    if field_type == "boolean":
        return parse_bool

    if field_type == "decimal":
        return parse_decimal

    return str


def add_write_fields(parser: argparse.ArgumentParser) -> None:
    for field in FIELD_DEFINITIONS:
        kwargs: dict[str, Any] = {
            "dest": field["fieldId"],
            "default": None,
            "help": f"{field['help']} [fieldId={field['fieldId']}, type={field['type']}]",
            "type": field_arg_type(str(field["type"])),
        }

        if field.get("choices"):
            kwargs["choices"] = field["choices"]

        parser.add_argument(field["flag"], **kwargs)


def command_read(args: argparse.Namespace) -> int:
    state = load_state(args.state_file)
    record = get_record(state, args.poiid)
    print_payload(build_payload(args.poiid, record), args.format)
    return 0


def command_write(args: argparse.Namespace) -> int:
    state = load_state(args.state_file)
    record = dict(get_record(state, args.poiid))
    changed_fields: list[str] = []

    for field in FIELD_DEFINITIONS:
        field_id = field["fieldId"]
        value = getattr(args, field_id)

        if value is None:
            continue

        record[field_id] = value
        changed_fields.append(field_id)

    if not changed_fields:
        raise SystemExit("write requires at least one mutable field")

    record["version"] = int(record.get("version", 0)) + 1
    record["updated_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    state["pois"][args.poiid] = record
    save_state(args.state_file, state)

    result = {
        "status": "ok",
        "poiid": args.poiid,
        "changed_fields": changed_fields,
        "record": build_payload(args.poiid, record),
    }
    print_payload(result, args.format)
    return 0


def command_schema(args: argparse.Namespace) -> int:
    payload = {
        "name": "mock-full-reduction-config",
        "version": 1,
        "resourceFlag": "--poiid",
        "fields": FIELD_DEFINITIONS,
    }
    print_payload(payload, args.format)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Mock full-reduction promotion config CLI for safe-mutation validation."
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=default_state_path(),
        help="Path to mock state JSON file.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    read_parser = subparsers.add_parser("read", help="Read one store config.")
    read_parser.add_argument("--poiid", required=True, help="Store / POI ID.")
    read_parser.add_argument(
        "--format",
        choices=("json", "pretty"),
        default="json",
        help="Output format.",
    )
    read_parser.set_defaults(func=command_read)

    write_parser = subparsers.add_parser("write", help="Write one or more mutable fields.")
    write_parser.add_argument("--poiid", required=True, help="Store / POI ID.")
    write_parser.add_argument(
        "--format",
        choices=("json", "pretty"),
        default="json",
        help="Output format.",
    )
    add_write_fields(write_parser)
    write_parser.set_defaults(func=command_write)

    schema_parser = subparsers.add_parser("schema", help="Print machine-readable CLI schema.")
    schema_parser.add_argument(
        "--format",
        choices=("json", "pretty"),
        default="json",
        help="Output format.",
    )
    schema_parser.set_defaults(func=command_schema)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
