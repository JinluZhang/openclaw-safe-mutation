import path from "node:path";

import { parameterCatalog } from "./catalog.js";
import type {
  MutationExecutionContext,
  MutationInvocation,
  ResolvedPatch,
  SnapshotNormalizerId
} from "./intent-types.js";
import { getValueAtPath } from "./object-path.js";

type TemplateValue = string | readonly string[];

export interface ShellInvocationTemplate {
  kind: "shell";
  commandTokens: readonly string[];
  workdir?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizerId;
}

export interface HttpInvocationTemplate {
  kind: "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  resultPath?: string;
  normalizer?: SnapshotNormalizerId;
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
  mutableFlags: Record<string, string | ExecFlagBinding>;
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
  read: MutationInvocationTemplate;
  write?: MutationInvocationTemplate;
  verify?: MutationInvocationTemplate;
  compareNormalizer?: SnapshotNormalizerId;
}

export interface MatchedProtectedMutation {
  binding: ProtectedMutationBinding;
  resourceId: string;
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

export function parseFieldValue(fieldId: string, rawValue: string): unknown {
  const catalogItem = parameterCatalog.find((item) => item.fieldId === fieldId);

  if (!catalogItem) {
    throw new Error(`Unsupported protected write field ${fieldId}.`);
  }

  switch (catalogItem.valueType) {
    case "boolean":
      return parseBoolean(rawValue);
    case "integer": {
      const parsed = Number.parseInt(rawValue, 10);

      if (!Number.isSafeInteger(parsed)) {
        throw new Error(
          `Unsupported integer value "${rawValue}" for field ${fieldId}.`
        );
      }

      return parsed;
    }
    case "decimal": {
      const parsed = Number(rawValue);

      if (!Number.isFinite(parsed)) {
        throw new Error(
          `Unsupported decimal value "${rawValue}" for field ${fieldId}.`
        );
      }

      return parsed;
    }
    case "enum":
    case "string":
    case "datetime":
      return rawValue;
    default:
      throw new Error(
        `Protected exec interception does not support field type ${catalogItem.valueType} for ${fieldId}.`
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

function matchExecBinding(
  binding: ProtectedMutationBinding,
  input: {
    command: string;
    workdir?: string;
    approvedPlanId?: string;
  }
): ExecMatchResult | undefined {
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

    const flagBinding = binding.match.mutableFlags[flag];

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
    fieldChanges.push({
      fieldId,
      operation: "set",
      normalizedInput: parseFieldValue(fieldId, rawValue)
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
      fieldChanges,
      executionContext,
      approvedPlanId: input.approvedPlanId,
      source: "exec"
    }
  };
}

function matchToolBinding(
  binding: ProtectedMutationBinding,
  input: {
    params: Record<string, unknown>;
    approvedPlanId?: string;
  }
): MatchedProtectedMutation | undefined {
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

  match(input: {
    toolName: string;
    params: Record<string, unknown>;
    approvedPlanId?: string;
  }): {
    matched?: MatchedProtectedMutation;
    error?: string;
  } {
    for (const binding of this.getCandidateBindings(input.toolName)) {
      if (binding.match.kind === "exec") {
        const command = getString(input.params.command);

        if (!command) {
          continue;
        }

        const result = matchExecBinding(binding, {
          command,
          workdir: getString(input.params.workdir),
          approvedPlanId: input.approvedPlanId
        });

        if (result?.error || result?.matched) {
          return result;
        }

        continue;
      }

      try {
        const matched = matchToolBinding(binding, {
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

export const defaultProtectedMutationBindings: readonly ProtectedMutationBinding[] = [
  {
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
      mutableFlags: Object.fromEntries(
        parameterCatalog
          .filter((item) => item.fieldId !== "full_reduction_tiers")
          .map((item) => [
            `--${item.fieldId.replaceAll("_", "-")}`,
            item.fieldId
          ])
      )
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
    compareNormalizer: "stripVolatileFields"
  }
];

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
    isRecord(value.read)
  );
}

export function loadProtectedMutationRegistry(
  rawBindings: unknown
): ProtectedMutationRegistry {
  if (rawBindings === undefined) {
    return new ProtectedMutationRegistry(defaultProtectedMutationBindings);
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
