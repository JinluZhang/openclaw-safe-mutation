import path from "node:path";
import { spawn } from "node:child_process";

import {
  hashFieldSchema,
  type FieldSchemaSource,
  type ProtectedFieldDefinition,
  validateFieldSchema
} from "./field-schema.js";
import type {
  MutationExecutionContext,
  MutationInvocation,
  ResolvedPatch,
  SnapshotNormalizer
} from "./intent-types.js";
import { getValueAtPath } from "./object-path.js";

type TemplateValue = string | readonly string[];

export interface ShellInvocationTemplate {
  kind: "shell";
  commandTokens: readonly string[];
  workdir?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizer;
}

export interface HttpInvocationTemplate {
  kind: "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizer;
}

export type MutationInvocationTemplate =
  | ShellInvocationTemplate
  | HttpInvocationTemplate;

export interface ExecFlagBinding {
  fieldId: string;
}

export interface ExecPreSubcommandFlagBinding {
  variableName: string;
  pathValue?: boolean;
  defaultValue?:
    | string
    | {
        kind: "relativeToScriptDir";
        path: string;
      };
}

export interface ExecCommandMutationMatch {
  kind: "exec";
  toolName: string;
  pythonExecutable?: boolean;
  scriptBasename?: string;
  writeSubcommand: string;
  readSubcommand?: string;
  preSubcommandFlags?: Record<string, ExecPreSubcommandFlagBinding>;
  ignoredWriteFlags?: readonly string[];
  resourceFlag: string;
  mutableFlags?: Record<string, string | ExecFlagBinding>;
  mutableFlagsFromSchema?: boolean;
}

export interface ToolPayloadMutationMatch {
  kind: "tool";
  toolName: string;
  resourceParamPath: string;
  payloadParamPath: string;
  approvedPlanIdParamPath?: string;
}

export interface ProtectedMutationBinding {
  id: string;
  protectedToolName: string;
  match: ExecCommandMutationMatch | ToolPayloadMutationMatch;
  fieldSchema: FieldSchemaSource;
  read: MutationInvocationTemplate;
  write?: MutationInvocationTemplate;
  verify?: MutationInvocationTemplate;
  compareNormalizer?: SnapshotNormalizer;
}

export interface MatchedProtectedMutation {
  binding: ProtectedMutationBinding;
  resourceId: string;
  fieldSchema: ProtectedFieldDefinition[];
  fieldSchemaHash: string;
  fieldChanges?: ResolvedPatch["fieldChanges"];
  payload?: Record<string, unknown>;
  executionContext: MutationExecutionContext;
  approvedPlanId?: string;
  source: "tool" | "exec";
}

interface ExecMatchResult {
  matched?: MatchedProtectedMutation;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokenLooksLikePython(token: string): boolean {
  const basename = path.basename(token);
  return /^python(?:\d+(?:\.\d+)*)?$/u.test(basename);
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token);
}

function splitFlagToken(token: string): {
  flag: string;
  inlineValue?: string;
} {
  const separatorIndex = token.indexOf("=");

  if (!token.startsWith("--") || separatorIndex < 0) {
    return {
      flag: token
    };
  }

  return {
    flag: token.slice(0, separatorIndex),
    inlineValue: token.slice(separatorIndex + 1)
  };
}

export function tokenizeShellCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }

      continue;
    }

    current += char;
  }

  if (escaping || quote) {
    return;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseBoolean(rawValue: string): boolean {
  const normalized = rawValue.trim().toLowerCase();

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(
    `Unsupported boolean value "${rawValue}" in protected write command.`
  );
}

export function parseFieldValue(
  field: ProtectedFieldDefinition,
  rawValue: string
): unknown {
  switch (field.valueType) {
    case "boolean":
      return parseBoolean(rawValue);
    case "integer": {
      const parsed = Number.parseInt(rawValue, 10);

      if (!Number.isSafeInteger(parsed)) {
        throw new Error(
          `Unsupported integer value "${rawValue}" for field ${field.fieldId}.`
        );
      }

      return parsed;
    }
    case "decimal": {
      const parsed = Number(rawValue);

      if (!Number.isFinite(parsed)) {
        throw new Error(
          `Unsupported decimal value "${rawValue}" for field ${field.fieldId}.`
        );
      }

      return parsed;
    }
    case "enum":
      if (field.enumValues && !field.enumValues.includes(rawValue)) {
        throw new Error(
          `Unsupported enum value "${rawValue}" for field ${field.fieldId}.`
        );
      }
      return rawValue;
    case "string":
    case "datetime":
      return rawValue;
    case "json":
      try {
        return JSON.parse(rawValue);
      } catch (error) {
        throw new Error(
          `Unsupported JSON value for field ${field.fieldId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    default:
      throw new Error(
        `Protected exec interception does not support field type ${field.valueType} for ${field.fieldId}.`
      );
  }
}

function quoteShellToken(token: string): string {
  return `'${token.replaceAll("'", `'"'"'`)}'`;
}

export function buildShellCommand(tokens: readonly string[]): string {
  return tokens.map((token) => quoteShellToken(token)).join(" ");
}

function resolveTemplateValue(
  rawValue: TemplateValue | undefined
): string {
  if (rawValue === undefined) {
    return "";
  }

  if (typeof rawValue === "string") {
    return rawValue;
  }

  return rawValue.join(" ");
}

function renderTemplateString(
  template: string,
  variables: ReadonlyMap<string, TemplateValue>
): string {
  return template.replaceAll(/\{\{([A-Za-z0-9_.:-]+)\}\}/gu, (_match, name) =>
    resolveTemplateValue(variables.get(String(name)))
  );
}

function renderTemplateTokens(
  templateTokens: readonly string[],
  variables: ReadonlyMap<string, TemplateValue>
): string[] {
  const tokens: string[] = [];
  const exactPlaceholderPattern = /^\{\{([A-Za-z0-9_.:-]+)\}\}$/u;

  for (const templateToken of templateTokens) {
    const exactMatch = exactPlaceholderPattern.exec(templateToken);

    if (exactMatch) {
      const value = variables.get(exactMatch[1]!);

      if (Array.isArray(value)) {
        tokens.push(...value);
      } else if (typeof value === "string" && value.length > 0) {
        tokens.push(value);
      }

      continue;
    }

    const rendered = renderTemplateString(templateToken, variables);

    if (rendered.length > 0) {
      tokens.push(rendered);
    }
  }

  return tokens;
}

export function renderInvocationTemplate(
  template: MutationInvocationTemplate,
  variables: ReadonlyMap<string, TemplateValue>
): MutationInvocation {
  if (template.kind === "shell") {
    const commandTokens = renderTemplateTokens(template.commandTokens, variables);
    return {
      kind: "shell",
      command: buildShellCommand(commandTokens),
      workdir: template.workdir
        ? renderTemplateString(template.workdir, variables)
        : undefined,
      resultPath: template.resultPath,
      normalizer: template.normalizer
    };
  }

  return {
    kind: "http",
    url: renderTemplateString(template.url, variables),
    method: template.method,
    headers: Object.fromEntries(
      Object.entries(template.headers ?? {}).map(([key, value]) => [
        key,
        renderTemplateString(value, variables)
      ])
    ),
    body: template.body
      ? renderTemplateString(template.body, variables)
      : undefined,
    resultPath: template.resultPath,
    normalizer: template.normalizer
  };
}

interface SchemaCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const schemaCache = new Map<
  string,
  {
    expiresAtMs: number;
    fields: ProtectedFieldDefinition[];
  }
>();

async function runSchemaShellCommand(params: {
  commandTokens: readonly string[];
  variables: ReadonlyMap<string, TemplateValue>;
}): Promise<SchemaCommandResult> {
  const command = buildShellCommand(
    renderTemplateTokens(params.commandTokens, params.variables)
  );

  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function selectSchemaFields(
  parsed: unknown,
  resultPath: string | undefined
): unknown {
  if (!resultPath) {
    if (isRecord(parsed) && Array.isArray(parsed.fields)) {
      return parsed.fields;
    }

    return parsed;
  }

  return getValueAtPath(isRecord(parsed) ? parsed : {}, resultPath);
}

async function resolveFieldSchema(params: {
  binding: ProtectedMutationBinding;
  variables: ReadonlyMap<string, TemplateValue>;
}): Promise<{
  fields: ProtectedFieldDefinition[];
  hash: string;
}> {
  const source = params.binding.fieldSchema;
  const cacheKey =
    source.kind === "inline"
      ? JSON.stringify(source)
      : source.kind === "shell"
        ? JSON.stringify({
            kind: source.kind,
            commandTokens: renderTemplateTokens(
              source.commandTokens,
              params.variables
            ),
            resultPath: source.resultPath
          })
        : JSON.stringify({
            kind: source.kind,
            url: renderTemplateString(source.url, params.variables),
            method: source.method,
            headers: Object.fromEntries(
              Object.entries(source.headers ?? {}).map(([key, value]) => [
                key,
                renderTemplateString(value, params.variables)
              ])
            ),
            body: source.body
              ? renderTemplateString(source.body, params.variables)
              : undefined,
            resultPath: source.resultPath
          });
  const now = Date.now();
  const cached = schemaCache.get(cacheKey);

  if (cached && cached.expiresAtMs > now) {
    return {
      fields: structuredClone(cached.fields),
      hash: hashFieldSchema(cached.fields)
    };
  }

  let rawFields: unknown;

  if (source.kind === "inline") {
    rawFields = source.fields;
  } else if (source.kind === "shell") {
    const result = await runSchemaShellCommand({
      commandTokens: source.commandTokens,
      variables: params.variables
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Protected write binding ${params.binding.id} schema discovery failed: ${
          result.stderr.trim() || `Command exited with code ${result.exitCode}`
        }`
      );
    }

    rawFields = selectSchemaFields(JSON.parse(result.stdout), source.resultPath);
  } else {
    const response = await fetch(
      renderTemplateString(source.url, params.variables),
      {
        method: source.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries(source.headers ?? {}).map(([key, value]) => [
            key,
            renderTemplateString(value, params.variables)
          ])
        ),
        body: source.body
          ? renderTemplateString(source.body, params.variables)
          : undefined
      }
    );
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Protected write binding ${params.binding.id} schema discovery failed: ${response.status} ${response.statusText}`
      );
    }

    rawFields = selectSchemaFields(JSON.parse(responseText), source.resultPath);
  }

  const fields = validateFieldSchema(
    rawFields,
    `protected mutation binding ${params.binding.id} fieldSchema`
  );

  if (source.kind !== "inline" && source.cacheTtlMs && source.cacheTtlMs > 0) {
    schemaCache.set(cacheKey, {
      expiresAtMs: now + source.cacheTtlMs,
      fields: structuredClone(fields)
    });
  }

  return {
    fields,
    hash: hashFieldSchema(fields)
  };
}

function resolveDefaultPreSubcommandFlagValue(params: {
  spec: ExecPreSubcommandFlagBinding;
  scriptDir: string;
}): string | undefined {
  if (params.spec.defaultValue === undefined) {
    return;
  }

  if (typeof params.spec.defaultValue === "string") {
    return params.spec.defaultValue;
  }

  if (params.spec.defaultValue.kind === "relativeToScriptDir") {
    return path.resolve(params.scriptDir, params.spec.defaultValue.path);
  }

  return;
}

async function matchExecBinding(
  binding: ProtectedMutationBinding,
  input: {
    command: string;
    workdir?: string;
    approvedPlanId?: string;
  }
): Promise<ExecMatchResult | undefined> {
  if (binding.match.kind !== "exec") {
    return;
  }

  const tokens = tokenizeShellCommand(input.command);

  if (!tokens || tokens.length === 0) {
    return;
  }

  let cursor = 0;
  const envAssignmentTokens: string[] = [];

  while (cursor < tokens.length && isEnvAssignment(tokens[cursor]!)) {
    envAssignmentTokens.push(tokens[cursor]!);
    cursor += 1;
  }

  if (cursor >= tokens.length) {
    return;
  }

  if (binding.match.pythonExecutable !== false && !tokenLooksLikePython(tokens[cursor]!)) {
    return;
  }

  const commandToken = tokens[cursor]!;
  cursor += 1;
  const commandOptionTokens: string[] = [];

  while (cursor < tokens.length && tokens[cursor]!.startsWith("-")) {
    commandOptionTokens.push(tokens[cursor]!);
    cursor += 1;
  }

  if (cursor >= tokens.length) {
    return {
      error: `Protected write binding ${binding.id} command is missing the script path.`
    };
  }

  const scriptToken = tokens[cursor]!;

  if (
    binding.match.scriptBasename &&
    path.basename(scriptToken) !== binding.match.scriptBasename
  ) {
    return;
  }

  const workdir = getString(input.workdir);
  const scriptPath = path.isAbsolute(scriptToken)
    ? scriptToken
    : workdir
      ? path.resolve(workdir, scriptToken)
      : path.resolve(scriptToken);
  const scriptDir = path.dirname(scriptPath);

  cursor += 1;

  const variables = new Map<string, TemplateValue>([
    ["envAssignmentTokens", envAssignmentTokens],
    ["commandToken", commandToken],
    ["commandOptionTokens", commandOptionTokens],
    ["pythonToken", commandToken],
    ["pythonOptionTokens", commandOptionTokens],
    ["scriptPath", scriptPath],
    ["scriptDir", scriptDir]
  ]);

  if (workdir) {
    variables.set("workdir", workdir);
  }

  const preSubcommandFlags = binding.match.preSubcommandFlags ?? {};
  let writeCommandSeen = false;

  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    const { flag, inlineValue } = splitFlagToken(token);

    if (token === binding.match.writeSubcommand) {
      writeCommandSeen = true;
      cursor += 1;
      break;
    }

    if (binding.match.readSubcommand && token === binding.match.readSubcommand) {
      return;
    }

    const flagSpec = preSubcommandFlags[flag];

    if (!flagSpec) {
      return {
        error: `Protected write binding ${binding.id} contains unsupported pre-write token ${token}.`
      };
    }

    const rawValue = inlineValue ?? tokens[cursor + 1];

    if (!rawValue) {
      return {
        error: `Protected write binding ${binding.id} is missing a value for ${flag}.`
      };
    }

    const value =
      flagSpec.pathValue && !path.isAbsolute(rawValue)
        ? path.resolve(workdir ?? process.cwd(), rawValue)
        : rawValue;

    variables.set(flagSpec.variableName, value);
    cursor += inlineValue !== undefined ? 1 : 2;
  }

  if (!writeCommandSeen) {
    return;
  }

  for (const [flag, spec] of Object.entries(preSubcommandFlags)) {
    if (variables.has(spec.variableName)) {
      continue;
    }

    const defaultValue = resolveDefaultPreSubcommandFlagValue({
      spec,
      scriptDir
    });

    if (defaultValue !== undefined) {
      variables.set(spec.variableName, defaultValue);
    } else {
      return {
        error: `Protected write binding ${binding.id} is missing required pre-write flag ${flag}.`
      };
    }
  }

  const resolvedSchema = await resolveFieldSchema({
    binding,
    variables
  });
  const fieldsById = new Map(
    resolvedSchema.fields.map((field) => [field.fieldId, field] as const)
  );
  const mutableFlags = {
    ...(binding.match.mutableFlags ?? {})
  };

  if (binding.match.mutableFlagsFromSchema) {
    for (const field of resolvedSchema.fields) {
      if (field.flag) {
        mutableFlags[field.flag] = {
          fieldId: field.fieldId
        };
      }
    }
  }

  let resourceId: string | undefined;
  const fieldChanges: ResolvedPatch["fieldChanges"] = [];

  while (cursor < tokens.length) {
    const { flag, inlineValue } = splitFlagToken(tokens[cursor]!);

    if (binding.match.ignoredWriteFlags?.includes(flag)) {
      const rawValue = inlineValue ?? tokens[cursor + 1];

      if (!rawValue) {
        return {
          error: `Protected write binding ${binding.id} is missing a value for ${flag}.`
        };
      }

      cursor += inlineValue !== undefined ? 1 : 2;
      continue;
    }

    if (flag === binding.match.resourceFlag) {
      const rawValue = inlineValue ?? tokens[cursor + 1];

      if (!rawValue) {
        return {
          error: `Protected write binding ${binding.id} is missing a value for ${flag}.`
        };
      }

      resourceId = rawValue;
      cursor += inlineValue !== undefined ? 1 : 2;
      continue;
    }

    const flagBinding = mutableFlags[flag];

    if (!flagBinding) {
      return {
        error: `Protected write binding ${binding.id} contains unsupported flag ${flag}.`
      };
    }

    const rawValue = inlineValue ?? tokens[cursor + 1];

    if (!rawValue) {
      return {
        error: `Protected write binding ${binding.id} is missing a value for ${flag}.`
      };
    }

    const fieldId =
      typeof flagBinding === "string" ? flagBinding : flagBinding.fieldId;
    const field = fieldsById.get(fieldId);

    if (!field) {
      return {
        error: `Protected write binding ${binding.id} references unknown schema field ${fieldId}.`
      };
    }

    fieldChanges.push({
      fieldId,
      operation: "set",
      normalizedInput: parseFieldValue(field, rawValue)
    });
    cursor += inlineValue !== undefined ? 1 : 2;
  }

  if (!resourceId) {
    return {
      error: `Protected write binding ${binding.id} is missing required ${binding.match.resourceFlag}.`
    };
  }

  if (fieldChanges.length === 0) {
    return {
      error: `Protected write binding ${binding.id} must include at least one mutable field.`
    };
  }

  variables.set("resourceId", resourceId);

  const readInvocation = renderInvocationTemplate(binding.read, variables);
  const verifyInvocation = binding.verify
    ? renderInvocationTemplate(binding.verify, variables)
    : readInvocation;
  const executionContext: MutationExecutionContext = {
    kind: "configured_mutation",
    bindingId: binding.id,
    protectedToolName: binding.protectedToolName,
    resourceId,
    readInvocation,
    writeInvocation: {
      kind: "shell",
      command: input.command.trim(),
      ...(workdir ? { workdir } : {})
    },
    verifyInvocation,
    compareNormalizer: binding.compareNormalizer,
    ...(workdir ? { workdir } : {})
  };

  return {
    matched: {
      binding,
      resourceId,
      fieldSchema: structuredClone(resolvedSchema.fields),
      fieldSchemaHash: resolvedSchema.hash,
      fieldChanges,
      executionContext,
      approvedPlanId: input.approvedPlanId,
      source: "exec"
    }
  };
}

async function matchToolBinding(
  binding: ProtectedMutationBinding,
  input: {
    params: Record<string, unknown>;
    approvedPlanId?: string;
  }
): Promise<MatchedProtectedMutation | undefined> {
  if (binding.match.kind !== "tool") {
    return;
  }

  const resourceValue = getValueAtPath(input.params, binding.match.resourceParamPath);
  const payloadValue = getValueAtPath(input.params, binding.match.payloadParamPath);

  if (typeof resourceValue !== "string" || !isRecord(payloadValue)) {
    return;
  }

  const variables = new Map<string, TemplateValue>([
    ["resourceId", resourceValue],
    ["payloadJson", JSON.stringify(payloadValue)]
  ]);

  for (const [key, value] of Object.entries(input.params)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      variables.set(`param:${key}`, String(value));
    }
  }
  const resolvedSchema = await resolveFieldSchema({
    binding,
    variables
  });
  const readInvocation = renderInvocationTemplate(binding.read, variables);
  const verifyInvocation = binding.verify
    ? renderInvocationTemplate(binding.verify, variables)
    : readInvocation;

  if (!binding.write) {
    throw new Error(
      `Protected write binding ${binding.id} must declare a write invocation for direct tool execution.`
    );
  }

  return {
    binding,
    resourceId: resourceValue,
    fieldSchema: structuredClone(resolvedSchema.fields),
    fieldSchemaHash: resolvedSchema.hash,
    payload: structuredClone(payloadValue),
    executionContext: {
      kind: "configured_mutation",
      bindingId: binding.id,
      protectedToolName: binding.protectedToolName,
      resourceId: resourceValue,
      readInvocation,
      writeInvocation: renderInvocationTemplate(binding.write, variables),
      verifyInvocation,
      compareNormalizer: binding.compareNormalizer
    },
    approvedPlanId: input.approvedPlanId,
    source: "tool"
  };
}

export class ProtectedMutationRegistry {
  readonly bindings: readonly ProtectedMutationBinding[];

  constructor(bindings: readonly ProtectedMutationBinding[]) {
    this.bindings = bindings;
  }

  get protectedToolNames(): readonly string[] {
    return Array.from(
      new Set(this.bindings.map((binding) => binding.protectedToolName))
    );
  }

  isProtectedToolName(toolName: string): boolean {
    return this.protectedToolNames.includes(toolName);
  }

  getCandidateBindings(toolName: string): readonly ProtectedMutationBinding[] {
    return this.bindings.filter((binding) => binding.match.toolName === toolName);
  }

  async match(input: {
    toolName: string;
    params: Record<string, unknown>;
    approvedPlanId?: string;
  }): Promise<{
    matched?: MatchedProtectedMutation;
    error?: string;
  }> {
    for (const binding of this.getCandidateBindings(input.toolName)) {
      if (binding.match.kind === "exec") {
        const command = getString(input.params.command);

        if (!command) {
          continue;
        }

        let result: ExecMatchResult | undefined;

        try {
          result = await matchExecBinding(binding, {
            command,
            workdir: getString(input.params.workdir),
            approvedPlanId: input.approvedPlanId
          });
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error)
          };
        }

        if (result?.error || result?.matched) {
          return result;
        }

        continue;
      }

      try {
        const matched = await matchToolBinding(binding, {
          params: input.params,
          approvedPlanId: input.approvedPlanId
        });

        if (matched) {
          return {
            matched
          };
        }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }

    return {};
  }
}

export const defaultProtectedMutationBindings: readonly ProtectedMutationBinding[] = [];

function looksLikeProtectedMutationBinding(
  value: unknown
): value is ProtectedMutationBinding {
  if (!isRecord(value) || !isRecord(value.match)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.protectedToolName === "string" &&
    (value.match.kind === "exec" || value.match.kind === "tool") &&
    isRecord(value.fieldSchema) &&
    isRecord(value.read)
  );
}

export function loadProtectedMutationRegistry(rawBindings: unknown): ProtectedMutationRegistry {
  if (rawBindings === undefined) {
    return new ProtectedMutationRegistry([]);
  }

  if (!Array.isArray(rawBindings)) {
    throw new Error("safe-mutation protectedMutations must be an array.");
  }

  const bindings = rawBindings.map((binding, index) => {
    if (!looksLikeProtectedMutationBinding(binding)) {
      throw new Error(
        `safe-mutation protectedMutations[${index}] is not a valid protected mutation binding.`
      );
    }

    return binding;
  });

  return new ProtectedMutationRegistry(bindings);
}

export const defaultProtectedMutationRegistry =
  new ProtectedMutationRegistry(defaultProtectedMutationBindings);
