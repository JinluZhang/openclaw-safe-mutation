import { createHash } from "node:crypto";

import type { MutationOperation } from "./intent-types.js";

export type ProtectedFieldValueType =
  | "string"
  | "boolean"
  | "integer"
  | "decimal"
  | "datetime"
  | "enum"
  | "json";

export interface ProtectedFieldDefinition {
  fieldId: string;
  flag?: string;
  label?: string;
  description?: string;
  valueType: ProtectedFieldValueType;
  readPath: string;
  requiredInPayload?: boolean;
  enumValues?: string[];
  operations?: MutationOperation[];
  display?: {
    format?: "plain" | "json" | "currency" | "percent" | "template";
    template?: string;
  };
}

export type FieldSchemaSource =
  | {
      kind: "inline";
      fields: ProtectedFieldDefinition[];
    }
  | {
      kind: "shell";
      commandTokens: readonly string[];
      resultPath?: string;
      cacheTtlMs?: number;
    }
  | {
      kind: "http";
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      resultPath?: string;
      cacheTtlMs?: number;
    };

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, normalizeForHash(record[key])])
    );
  }

  return value;
}

export function hashFieldSchema(
  fields: readonly ProtectedFieldDefinition[]
): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForHash(fields)))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const protectedValueTypes: readonly ProtectedFieldValueType[] = [
  "string",
  "boolean",
  "integer",
  "decimal",
  "datetime",
  "enum",
  "json"
];

export function validateFieldSchema(
  rawFields: unknown,
  sourceLabel: string
): ProtectedFieldDefinition[] {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new Error(`${sourceLabel} must provide a non-empty fields array.`);
  }

  const fieldIds = new Set<string>();

  return rawFields.map((rawField, index) => {
    if (!isRecord(rawField)) {
      throw new Error(`${sourceLabel}.fields[${index}] must be an object.`);
    }

    const fieldId = rawField.fieldId;
    const valueType = rawField.valueType;
    const readPath = rawField.readPath;

    if (typeof fieldId !== "string" || fieldId.length === 0) {
      throw new Error(`${sourceLabel}.fields[${index}].fieldId is required.`);
    }

    if (fieldIds.has(fieldId)) {
      throw new Error(`${sourceLabel} contains duplicate fieldId ${fieldId}.`);
    }

    fieldIds.add(fieldId);

    if (
      typeof valueType !== "string" ||
      !protectedValueTypes.includes(valueType as ProtectedFieldValueType)
    ) {
      throw new Error(
        `${sourceLabel}.fields[${index}].valueType is not supported.`
      );
    }

    if (typeof readPath !== "string" || readPath.length === 0) {
      throw new Error(`${sourceLabel}.fields[${index}].readPath is required.`);
    }

    if (
      valueType === "enum" &&
      rawField.enumValues !== undefined &&
      (!Array.isArray(rawField.enumValues) ||
        rawField.enumValues.some((item) => typeof item !== "string"))
    ) {
      throw new Error(
        `${sourceLabel}.fields[${index}].enumValues must be an array of strings.`
      );
    }

    return structuredClone(rawField) as unknown as ProtectedFieldDefinition;
  });
}

export function getFieldLabel(field: ProtectedFieldDefinition): string {
  return field.label ?? field.fieldId;
}
