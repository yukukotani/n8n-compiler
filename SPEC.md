# TypeScript -> n8n Workflow Compiler Specification

## 1. Overview

This project provides a compiler that converts TypeScript workflow code into n8n workflow JSON and deploys it via the n8n Public API.

The core idea is:

- Users write normal TypeScript in an `execute` method.
- Control flow (`if`, `for`) is parsed from AST and converted into n8n graph structure (`nodes`, `connections`).
- The compiler never executes user code. It only performs static analysis.

## 2. Goals

- Write workflow logic in TypeScript with natural control flow.
- Convert TypeScript control flow into n8n graph semantics.
- Provide first-class type definitions for the workflow authoring API.
- Validate and emit deterministic workflow JSON.
- Deploy to n8n through `/api/v1/workflows` endpoints.

## 3. Non-goals (MVP)

- Full JavaScript runtime evaluation.
- Support for every TypeScript/JavaScript statement.
- Auto-support for all n8n node types from day one.
- Managing credentials lifecycle beyond referencing credential IDs.

## 4. External Interfaces

### 4.1 Parser (oxc-parser)

Use `parseSync(filename, sourceText, options)`.

Recommended options:

- `lang: "ts"`
- `sourceType: "module"`
- `range: true`
- `showSemanticErrors: true`

The compiler consumes `program`, `errors`, and source ranges.

### 4.2 n8n API

Base path: `/api/v1`

Auth header:

- `X-N8N-API-KEY: <token>`

Workflow endpoints used:

- `POST /workflows` (create)
- `PUT /workflows/{id}` (update)
- `GET /workflows?name=...` (upsert lookup)
- `POST /workflows/{id}/activate` (optional activate)

Minimum workflow payload fields:

- `name`
- `nodes`
- `connections`
- `settings`

## 5. Authoring Model

Users define a workflow with a `triggers` array and an imperative `execute` method.

Triggers are specified separately from `execute`, allowing multiple triggers per workflow.

Example:

```ts
import { workflow, n } from "@n8n-compiler/dsl";

export default workflow({
  name: "sample",
  settings: {
    timezone: "Asia/Tokyo",
    saveDataErrorExecution: "all",
    saveDataSuccessExecution: "none",
  },
  triggers: [n.manualTrigger()],
  execute() {
    n.httpRequest({
      method: "GET",
      url: "https://example.com/items",
    });

    if (n.expr("={{$json.ok === true}}")) {
      n.set({
        assignments: {
          assignments: [{ name: "status", value: "ok", type: "string" }],
        },
      });
    } else {
      n.noOp();
    }

    for (const _ of n.loop({ batchSize: 1 })) {
      n.httpRequest({
        method: "GET",
        url: "={{$json.nextUrl}}",
      });
    }
  },
});
```

## 6. Supported Syntax (MVP)

Trigger nodes (e.g. `n.manualTrigger()`) must be placed in the `triggers` array, not inside `execute`. Using trigger nodes inside `execute` is a compile error.

Inside `execute`, the compiler supports:

- `BlockStatement`
- `ExpressionStatement` for known DSL calls (node creation)
- `VariableDeclaration` for naming node refs
- `IfStatement`
- `ForOfStatement` limited to `for (... of n.loop(...))`

Unsupported in MVP (compile error):

- `for(;;)`, `while`, `do..while`
- `switch`, `try/catch/finally`
- `break`, `continue`
- arbitrary function calls affecting graph shape
- async control primitives that alter graph topology dynamically

## 7. DSL API and Types

The project publishes TypeScript definitions for authoring.

```ts
export type WorkflowDefinition = {
  name: string;
  settings?: WorkflowSettings;
  triggers: NodeRef<TriggerNodeKind>[];
  execute: () => void | Promise<void>;
};

export declare function workflow(def: WorkflowDefinition): WorkflowDefinition;

export declare const n: {
  // Trigger nodes (used in `triggers` array, NOT inside `execute`)
  manualTrigger(params?: Record<string, unknown>): NodeRef;

  // Action nodes (used inside `execute`)
  httpRequest(params: Record<string, unknown>): NodeRef;
  set(params: Record<string, unknown>): NodeRef;
  noOp(params?: Record<string, unknown>): NodeRef;

  // Utilities
  expr(value: `={{${string}}}`): ConditionRef;
  loop(options?: { batchSize?: number; reset?: boolean }): Iterable<LoopToken>;
};
```

Notes:

- `n.expr(...)` is a marker for runtime n8n expression conditions.
- `n.loop(...)` is only valid as source of `for..of` in `execute`.

## 8. Compiler Pipeline

1. Parse source with `oxc-parser`.
2. Locate `export default workflow({...})`.
3. Extract `name`, optional `settings`, `triggers` array, and `execute` function body.
4. Parse `triggers` array into trigger IR entries.
5. Convert `execute` statements to CFG-like intermediate representation (IR).
6. Lower triggers + CFG into n8n `nodes` and `connections`.
7. Validate emitted workflow schema + graph constraints.
8. Output JSON (`compile`) and optionally deploy (`deploy`).

## 9. Intermediate Representation

```ts
type WorkflowIR = {
  name: string;
  settings: WorkflowSettings;
  nodes: NodeIR[];
  edges: EdgeIR[];
};

type NodeIR = {
  key: string;
  n8nType: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name?: string }>;
  position?: [number, number];
};

type EdgeIR = {
  from: string;
  fromOutputIndex: number;
  to: string;
  toInputIndex: number;
};
```

`fromOutputIndex` uses n8n output ordering conventions.

## 10. Control-flow Lowering Rules

### 10.1 Sequential statements

- Maintain `frontier` (reachable output ports).
- For each created node, connect all frontier ports into that node input.
- Replace frontier with that node's default output.

### 10.2 `if` -> n8n If node

For `if (COND) THEN else ELSE`:

1. Emit one `n8n-nodes-base.if` node.
2. Connect current frontier to If input.
3. Route If output index `0` (true) into `THEN` branch start.
4. Route If output index `1` (false) into `ELSE` branch start.
5. Merge branch terminal frontiers and continue.

If there is no `else`, false branch frontier passes through unchanged.

MVP condition support:

- `if (n.expr("={{...}}"))`
- `if (true)` / `if (false)` for compile-time branch pruning

Future phase can translate simple binary/logical expressions automatically.

### 10.3 `for..of n.loop()` -> Loop Over Items

For `for (const _ of n.loop(opts)) { BODY }`:

1. Emit `n8n-nodes-base.splitInBatches` (typeVersion `3`).
2. Connect current frontier to loop node input.
3. Loop node output index `1` (`loop`) enters `BODY`.
4. `BODY` terminal frontier connects back to loop node input (back-edge).
5. Loop node output index `0` (`done`) becomes post-loop frontier.

This matches n8n loop wiring semantics (`done`, `loop`).

## 11. n8n Node Mapping

Initial built-in mapping:

- `n.manualTrigger()` -> `n8n-nodes-base.manualTrigger`
- `n.httpRequest(params)` -> `n8n-nodes-base.httpRequest`
- `n.set(params)` -> `n8n-nodes-base.set`
- `n.noOp()` -> `n8n-nodes-base.noOp`
- synthetic from compiler:
  - `if` -> `n8n-nodes-base.if`
  - `for` -> `n8n-nodes-base.splitInBatches`

Unknown DSL functions are compile errors (`E_UNKNOWN_NODE_CALL`).

## 12. Connections Emission

Emit canonical n8n connections object:

```json
{
  "NodeA": {
    "main": [
      [
        { "node": "NodeB", "type": "main", "index": 0 }
      ]
    ]
  }
}
```

For multi-output nodes, `main` is an array where each output index has its own edge list.

## 13. Naming, IDs, and Layout

- Node display name:
  - from bound variable name when possible
  - otherwise `<kind>_<counter>`
- Node id:
  - deterministic hash from file path + source range + node kind
- Position:
  - auto-layout grid by control-flow depth and statement order
  - stable deterministic output for clean diffs

## 14. Validation

### 14.1 Structural

- Workflow has required fields (`name`, `nodes`, `connections`, `settings`).
- At least one trigger-like start node.
- Every edge references existing nodes.

### 14.2 Control-flow

- No dangling frontiers at function end (unless explicitly allowed).
- Loop back-edge exists for each lowered `for..of n.loop()`.
- If branches are wired correctly with output indexes `0` and `1`.

### 14.3 API payload

- Enforce n8n schema-compatible data shape before request.

## 15. CLI

Commands:

- `bun run cli.ts compile <entry.ts> --out workflow.json`
- `bun run cli.ts validate <entry.ts>`
- `bun run cli.ts deploy <entry.ts> [--mode create|update|upsert] [--id <id>] [--activate]`

Options:

- `--base-url` (fallback: `N8N_BASE_URL`)
- `--api-key` (fallback: `N8N_API_KEY`)
- `--strict`
- `--json`

Exit codes:

- `0`: success
- `1`: compile/validate error
- `2`: API/deploy error

## 16. Diagnostics

```ts
type Diagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  start?: number;
  end?: number;
  hint?: string;
};
```

Primary error codes:

- `E_PARSE`
- `E_ENTRY_NOT_FOUND`
- `E_EXECUTE_NOT_FOUND`
- `E_TRIGGERS_NOT_FOUND`
- `E_INVALID_TRIGGER`
- `E_UNSUPPORTED_STATEMENT`
- `E_UNSUPPORTED_IF_TEST`
- `E_UNSUPPORTED_FOR_FORM`
- `E_INVALID_LOOP_SOURCE`
- `E_UNKNOWN_NODE_CALL`
- `E_INVALID_CONNECTION`
- `E_INVALID_WORKFLOW_SCHEMA`
- `E_API_UNAUTHORIZED`
- `E_API_CONFLICT`
- `E_API_NETWORK`

## 17. Security and Safety

- Never execute user workflow code during compile.
- Do not log API keys or sensitive headers.
- Mask secrets in error output.
- Deterministic output for reviewable diffs.

## 18. Testing Strategy (Bun)

- Unit tests for parser adapters, CFG builder, lowering, validator.
- Snapshot tests: input `.ts` -> output workflow `.json`.
- Integration tests with mocked n8n API endpoints.
- Diagnostics snapshot tests with source ranges.

Test command:

- `bun test`

## 19. Directory Layout (planned)

```txt
src/
  cli.ts
  compiler/
    parse.ts
    extract-entry.ts
    cfg.ts
    lower-n8n.ts
    validate.ts
    diagnostics.ts
  dsl/
    index.ts
    types.ts
    nodes.ts
  n8n/
    client.ts
    deploy.ts
test/
  fixtures/
  snapshots/
  unit/
```

## 20. Milestones

### Phase 1 (MVP)

- Imperative `execute` parsing
- Sequential + `if` + `for..of n.loop()` lowering
- JSON compile + validate + deploy

### Phase 2

- Extend `if` test translation (simple TS expressions)
- Better auto-layout and naming strategies
- Expand node helper coverage

### Phase 3

- Additional control flow constructs
- Multi-file support and richer symbol resolution
- Enhanced optimization and graph simplification
