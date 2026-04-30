# Generalized Safe Mutation Design

## Background

This repository currently proves the safe mutation workflow with one demo skill:
`mock-full-reduction-config`. The core approval flow is useful beyond the demo:

- intercept a protected write path;
- read the current state;
- freeze a mutation plan;
- ask the user to confirm;
- execute the frozen write after approval;
- detect conflicts before writing;
- verify the final state after writing.

However, several core files still contain code that is specific to the mock full
reduction sample. Before the project is opened to external users, those sample
assumptions should be moved out of the framework so other write skills can be
integrated without editing TypeScript source code.

The target shape is a generic protected-write framework. A skill author should
only need to expose a read command, a write command, and a machine-readable
field schema, then add one plugin binding.

## Goals

- Do not hard-code business fields in the framework.
- Keep `mock-full-reduction-config` as an example only.
- Allow each protected mutation binding to provide its own field schema.
- Support dynamic schema discovery from a skill command such as
  `schema --format json`.
- Freeze the schema, binding, invocations, payload, and diff into each plan.
- Keep fail-closed behavior for unknown fields, unknown flags, missing resource
  IDs, invalid values, and missing read configuration.
- Make onboarding clear enough that external users can add their own write skill
  quickly.

## Non-Goals

- Do not parse arbitrary human-oriented `--help` text as the primary contract.
- Do not require every skill to use Python or CLI tools.
- Do not require a single global catalog for all skills.
- Do not remove the current approval and execution safety model.

## Recommended Skill Contract

Skills may continue to expose normal human-readable help, but safe mutation
should use a machine-readable schema command.

Recommended command:

```bash
your_cli.py schema --format json
```

Recommended response:

```json
{
  "resourceFlag": "--poiid",
  "writeSubcommand": "write",
  "readSubcommand": "read",
  "fields": [
    {
      "fieldId": "shop_name",
      "flag": "--shop-name",
      "label": "门店名称",
      "description": "Shop display name",
      "valueType": "string",
      "readPath": "shop.name",
      "requiredInPayload": true
    },
    {
      "fieldId": "enabled",
      "flag": "--enabled",
      "label": "营业状态",
      "valueType": "boolean",
      "readPath": "enabled"
    }
  ],
  "ignoredFlags": ["--format"]
}
```

The framework can still support inline schemas in plugin config for simple
cases, but dynamic schema discovery should be the preferred external contract.

## Core Data Model

Add a binding-level field schema model:

```ts
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
```

Add schema sources to `ProtectedMutationBinding`:

```ts
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
```

Each matched protected mutation should carry the resolved schema:

```ts
interface MatchedProtectedMutation {
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
```

Each `MutationPlan` should freeze the schema and binding context used to create
the approval:

```ts
interface MutationPlan {
  fieldSchemaSnapshot: ProtectedFieldDefinition[];
  fieldSchemaHash: string;
  bindingSnapshot?: ProtectedMutationBinding;
}
```

Execution after approval must use the frozen plan data, not a newly loaded
schema.

## Mock-Specific Coupling Points And Required Changes

### `src/catalog.ts`

Current issue:

- Contains a global full-reduction field catalog.
- Contains `FULL_REDUCTION_TIER_SCALAR_FIELD_IDS`.
- Treats mock promotion fields as framework fields.

Required change:

- Replace global business catalog usage with binding-level
  `ProtectedFieldDefinition[]`.
- Keep only generic type definitions in a new `src/field-schema.ts`.
- Move the full-reduction catalog to an example schema file under
  `examples/mock-full-reduction/`.
- If backwards compatibility is needed during migration, provide a converter
  from the old catalog shape into `ProtectedFieldDefinition[]`.

### `src/mutation-registry.ts`

Current issue:

- `parseFieldValue` reads from the global `parameterCatalog`.
- The default binding is hard-coded to `mock-full-reduction.exec`.
- The default binding references `mock_full_reduction_cli.py`, `--poiid`,
  the mock state file, and `mockFullReductionRead`.
- `mutableFlags` for the mock binding are generated from the global catalog.

Required change:

- Make `parseFieldValue` accept a `ProtectedFieldDefinition`.
- Load or resolve the field schema while matching a binding.
- Support `mutableFlagsFromSchema: true`; when enabled, each schema field with
  a `flag` becomes a mutable flag.
- Keep explicit `mutableFlags` for users who do not want schema-driven flag
  mapping.
- Remove mock default bindings from core.
- Change omitted `protectedMutations` to mean "no protected bindings" by
  default.

### `src/protected-write-request.ts`

Current issue:

- Imports the global `parameterCatalog`.
- Builds write payload with the mock-oriented global catalog.

Required change:

- Use `matched.fieldSchema`.
- Pass the resolved schema into `buildWritePayload`.
- Return `fieldSchema` and `fieldSchemaHash` in `ProtectedWriteRequest`.

### `src/protected-write-plan.ts`

Current issue:

- Imports the global `parameterCatalog`.
- Contains full-reduction-specific logic that collapses tier scalar fields when
  `full_reduction_tiers` changes.
- Renders interpretation text with global catalog labels.

Required change:

- Accept `fieldSchema` in `EnsureProtectedWritePlanInput`.
- Build `resolvedPatch`, `diffItems`, `interpretationText`, and user text from
  the provided schema.
- Freeze `fieldSchemaSnapshot` and `fieldSchemaHash` into the plan.
- Remove all full-reduction tier scalar special cases from core.
- If a business needs derived-field behavior, handle it through a configured
  payload transformer or example-specific schema/read shape.

### `src/payload-builder.ts`

Current issue:

- Most of the file exists to synchronize full-reduction scalar fields with
  `promotion.full_reduction_tiers`.

Required change:

- Keep the generic operation:
  read current snapshot, apply each field change at `field.readPath`, and
  return a complete write payload.
- Move derived-field logic behind an optional transformer:

```ts
type PayloadTransform =
  | { kind: "none" }
  | { kind: "shell"; commandTokens: readonly string[] }
  | { kind: "jsonRules"; rules: readonly JsonTransformRule[] };
```

- First implementation can support only `none`, then move the mock full
  reduction behavior into the example by making its read/write schema
  consistent.

### `src/diff.ts`

Current issue:

- Imports global `parameterCatalog`.

Required change:

- Change `buildDiffItems` to accept `fieldSchema`.
- Use `field.readPath` and `field.label`.
- Fall back to `fieldId` when no label exists.

### `src/tool-backed-adapters.ts`

Current issue:

- Contains `normalizeMockFullReductionReadSnapshot`.
- `applySnapshotNormalizer` switches on string IDs including
  `mockFullReductionRead`.

Required change:

- Replace string-only normalizers with a generic normalizer spec:

```ts
type SnapshotNormalizerSpec =
  | { kind: "none" }
  | { kind: "stripFields"; paths: string[] }
  | { kind: "pickPath"; path: string }
  | { kind: "renamePath"; from: string; to: string }
  | { kind: "compose"; steps: SnapshotNormalizerSpec[] };
```

- Keep a compatibility adapter for old string IDs only during migration.
- Move mock full-reduction normalization out of core.

### `src/intent-types.ts`

Current issue:

- `SnapshotNormalizerId` includes `mockFullReductionRead`.
- `MutationPlan` has no frozen schema snapshot.

Required change:

- Replace or supplement `SnapshotNormalizerId` with `SnapshotNormalizerSpec`.
- Add `fieldSchemaSnapshot` and `fieldSchemaHash` to `MutationPlan`.
- Consider adding `bindingSnapshot` for auditability and execution stability.

### `src/channels/text-render.ts`

Current issue:

- Formats arrays of `{ threshold, reduction }` as full-reduction tiers.

Required change:

- Use `field.display` from the frozen schema when rendering diff values.
- Provide generic defaults:
  - primitive values render directly;
  - arrays and objects render as compact JSON;
  - long values are truncated safely.
- Move custom tier formatting to example display configuration if needed.

### `openclaw.entry.ts` and `openclaw.plugin.json`

Original issue:

- Config text was tied to the mock example instead of generic bindings.
- `dataDir` description mentions fake store snapshots.

Required change:

- Update config descriptions for generic protected mutations.
- Do not imply a mock binding is enabled in production.

### `skills/mock-full-reduction-config`

Current issue:

- The sample skill is packaged as if it were part of the core product.
- Its schema is only partially machine-readable through existing help/schema
  behavior.

Required change:

- Move or mirror it under `examples/mock-full-reduction/`.
- Ensure it exposes a complete `schema --format json` contract that matches the
  generic field schema.
- Keep it as a runnable example in docs and tests.

### Tests

Current issue:

- Many unit and integration tests create mock full-reduction fixtures.

Required change:

- Split tests into:
  - core generic tests with a minimal inline schema;
  - binding tests for `exec`, direct `tool`, shell schema, and HTTP schema;
  - example tests for mock full reduction.
- Required test cases:
  - inline schema creates a plan;
  - shell schema discovery creates a plan;
  - unknown flag fails closed;
  - missing resource ID fails closed;
  - invalid typed value fails closed;
  - schema change after plan creation does not change execution semantics;
  - conflict prevents write;
  - verify failure marks plan failed;
  - direct tool binding requires a write invocation;
  - normalizer strips volatile fields.

## Binding Examples

### Inline Schema

```json
{
  "id": "shop-settings.exec",
  "protectedToolName": "shop-settings",
  "match": {
    "kind": "exec",
    "toolName": "exec",
    "pythonExecutable": true,
    "scriptBasename": "shop_settings_cli.py",
    "writeSubcommand": "write",
    "readSubcommand": "read",
    "resourceFlag": "--poiid",
    "mutableFlagsFromSchema": true,
    "ignoredWriteFlags": ["--format"]
  },
  "fieldSchema": {
    "kind": "inline",
    "fields": [
      {
        "fieldId": "shop_name",
        "flag": "--shop-name",
        "label": "门店名称",
        "valueType": "string",
        "readPath": "shop.name"
      },
      {
        "fieldId": "enabled",
        "flag": "--enabled",
        "label": "营业状态",
        "valueType": "boolean",
        "readPath": "enabled"
      }
    ]
  },
  "read": {
    "kind": "shell",
    "commandTokens": [
      "{{pythonToken}}",
      "{{scriptPath}}",
      "read",
      "--poiid",
      "{{resourceId}}",
      "--format",
      "json"
    ]
  },
  "compareNormalizer": {
    "kind": "stripFields",
    "paths": ["updated_at", "version"]
  }
}
```

### Dynamic Shell Schema

```json
{
  "id": "shop-settings.exec",
  "protectedToolName": "shop-settings",
  "match": {
    "kind": "exec",
    "toolName": "exec",
    "pythonExecutable": true,
    "scriptBasename": "shop_settings_cli.py",
    "writeSubcommand": "write",
    "readSubcommand": "read",
    "resourceFlag": "--poiid",
    "mutableFlagsFromSchema": true,
    "ignoredWriteFlags": ["--format"]
  },
  "fieldSchema": {
    "kind": "shell",
    "commandTokens": [
      "{{pythonToken}}",
      "{{scriptPath}}",
      "schema",
      "--format",
      "json"
    ],
    "resultPath": "fields",
    "cacheTtlMs": 60000
  },
  "read": {
    "kind": "shell",
    "commandTokens": [
      "{{pythonToken}}",
      "{{scriptPath}}",
      "read",
      "--poiid",
      "{{resourceId}}",
      "--format",
      "json"
    ]
  }
}
```

## Migration Plan

1. Add generic field schema types and schema loading helpers.
2. Adapt the old full-reduction catalog into the new schema type so existing
   tests still pass.
3. Change parsing, payload building, diff building, and plan creation to accept
   schema explicitly.
4. Freeze schema snapshots in mutation plans.
5. Add inline field schema support in bindings.
6. Add shell and HTTP dynamic schema support.
7. Add generic normalizer specs.
8. Move mock default binding out of core and document the example binding.
9. Move mock-specific tier formatting and normalization out of core.
10. Rewrite docs and tests around the generic framework.

## Implementation Task For A New Session

Implement the generalized safe mutation architecture described in
`docs/generalized-safe-mutation-design.md`.

Start by reading these files:

- `src/catalog.ts`
- `src/mutation-registry.ts`
- `src/protected-write-request.ts`
- `src/protected-write-plan.ts`
- `src/payload-builder.ts`
- `src/diff.ts`
- `src/tool-backed-adapters.ts`
- `src/intent-types.ts`
- `src/channels/text-render.ts`
- `docs/generalized-safe-mutation-design.md`

Expected outcome:

- Core safe-mutation code no longer depends on mock full-reduction fields.
- Each protected mutation binding can provide its own field schema, either
  inline or dynamically through shell/HTTP schema discovery.
- Plan creation freezes the resolved field schema and uses that frozen schema
  for diff rendering, validation, and execution.
- Mock full-reduction remains available only as an example or compatibility
  fixture, not as the default core binding.
- Tests cover generic inline schema, dynamic schema discovery, exec matching,
  direct tool matching, conflict detection, verify failure, and fail-closed
  behavior.

Implementation constraints:

- Preserve the current approval, frozen plan, conflict detection, and verify
  semantics.
- Keep changes incremental and testable.
- Do not parse human-oriented `--help` text as the default schema contract.
- Prefer backward-compatible adapters where useful, but keep the final core API
  generic.
