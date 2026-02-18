/**
 * Generates TypeScript DSL source code from an n8n workflow JSON.
 *
 * The algorithm:
 *   1. Build an adjacency graph from nodes + connections.
 *   2. Identify trigger nodes as entry points.
 *   3. Walk the graph in topological order, recognising control-flow patterns:
 *      - If node (n8n-nodes-base.if) → `if (...) { ... } else { ... }`
 *      - SplitInBatches (n8n-nodes-base.splitInBatches) → `for (const _ of n.loop(...)) { ... }`
 *      - Switch node (n8n-nodes-base.switch) → `switch (...) { case ...: ... }`
 *      - Fan-out (multiple edges from same output) → `n.parallel(() => { ... }, ...)`
 *   4. Emit DSL code with proper indentation.
 */

import { parseSync as oxcParseSync } from "oxc-parser";
import { normalizeParameters } from "./normalize-params";

// ── Types ─────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

export type N8nWorkflowInput = {
  name: string;
  nodes: N8nNodeInput[];
  connections: N8nConnectionsInput;
  settings?: JsonObject;
};

export type N8nNodeInput = {
  name: string;
  type: string;
  typeVersion: number;
  parameters: JsonObject;
  credentials?: Record<string, unknown>;
  position?: [number, number];
};

type N8nConnectionItem = {
  node: string;
  type: string;
  index: number;
};

type N8nConnectionsInput = Record<
  string,
  { main: N8nConnectionItem[][] }
>;

export type GenerateResult = {
  code: string | null;
  errors: string[];
};

// ── n8n type → DSL kind mapping ───────────────────────────────────────────────

const N8N_TYPE_TO_DSL_KIND: Record<string, string> = {
  "n8n-nodes-base.manualTrigger": "manualTrigger",
  "n8n-nodes-base.scheduleTrigger": "scheduleTrigger",
  "n8n-nodes-base.webhook": "webhookTrigger",
  "n8n-nodes-base.googleCalendarTrigger": "googleCalendarTrigger",
  "n8n-nodes-base.httpRequest": "httpRequest",
  "n8n-nodes-base.executeworkflow": "executeWorkflow",
  "n8n-nodes-base.code": "code",
  "n8n-nodes-base.aggregate": "aggregate",
  "n8n-nodes-base.filter": "filter",
  "n8n-nodes-base.limit": "limit",
  "n8n-nodes-base.merge": "merge",
  "n8n-nodes-base.removeduplicates": "removeDuplicates",
  "n8n-nodes-base.respondToWebhook": "respondToWebhook",
  "n8n-nodes-base.sort": "sort",
  "n8n-nodes-base.splitout": "splitOut",
  "n8n-nodes-base.switch": "switch",
  "n8n-nodes-base.summarize": "summarize",
  "n8n-nodes-base.set": "set",
  "n8n-nodes-base.wait": "wait",
  "n8n-nodes-base.noOp": "noOp",
  "n8n-nodes-base.googleCalendar": "googleCalendar",
};

const TRIGGER_N8N_TYPES = new Set([
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.googleCalendarTrigger",
]);

const CONTROL_FLOW_TYPES = new Set([
  "n8n-nodes-base.if",
  "n8n-nodes-base.splitInBatches",
  "n8n-nodes-base.switch",
]);

// ── Graph structures ──────────────────────────────────────────────────────────

type GraphNode = {
  name: string;
  type: string;
  typeVersion: number;
  parameters: JsonObject;
  credentials?: Record<string, unknown>;
  dslKind: string | null;
  isTrigger: boolean;
  isControlFlow: boolean;
};

/** from node name → output index → target node names (ordered) */
type AdjacencyMap = Map<string, Map<number, string[]>>;

/** to node name → set of source node names */
type ReverseAdjacencyMap = Map<string, Set<string>>;

/** Set of edges that are loop-back edges (target → splitInBatches) */
type LoopBackEdges = Set<string>; // encoded as "from->to"

// ── Shared value extraction ───────────────────────────────────────────────────

/**
 * Module-level map for the current generation pass.
 * Maps canonicalJson(value) → const variable name.
 * Used by serialization functions to emit identifier references instead of literals.
 */
let _sharedValues: Map<string, string> = new Map();
/** Reverse lookup: const name → the original value (for const declaration generation). */
let _sharedValueData: Map<string, unknown> = new Map();
/** Set of shared const names actually referenced during serialization. */
let _usedSharedValues: Set<string> = new Set();

/** Set of n8n globals (DateTime, $, etc.) used by unwrapped expressions. */
let _usedN8nGlobals: Set<string> = new Set();

/**
 * Maps trigger display name → { paramName, triggerIndex }.
 * Used to replace `$('Trigger Name').item.json.xxx` → `paramName.xxx` in expressions.
 */
let _triggerRefMap: Map<string, { paramName: string; triggerIndex: number }> = new Map();
/** Set of trigger indices actually referenced by `$('...')` expressions. */
let _referencedTriggers: Set<number> = new Set();

/**
 * Canonical JSON representation with sorted keys for consistent comparison.
 */
function canonicalJson(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
}

function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/**
 * Scans all nodes for object values that appear 2+ times across credentials and
 * top-level parameter entries. Returns a map of canonicalJson → constName.
 * Also populates `_sharedValueData` as a side effect.
 */
function collectSharedValues(nodeMap: Map<string, GraphNode>): Map<string, string> {
  const occurrences = new Map<string, { key: string; value: unknown; count: number }>();

  function recordValue(key: string, value: unknown) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    const json = canonicalJson(value);
    const existing = occurrences.get(json);
    if (existing) {
      existing.count++;
    } else {
      occurrences.set(json, { key, value, count: 1 });
    }
  }

  for (const node of nodeMap.values()) {
    // Scan credential entries
    if (node.credentials) {
      for (const [key, value] of Object.entries(node.credentials)) {
        recordValue(key, value);
      }
    }
    // Scan top-level parameter entries (object values only)
    for (const [key, value] of Object.entries(node.parameters)) {
      recordValue(key, value);
    }
  }

  // Filter for 2+ occurrences with valid identifier keys
  const result = new Map<string, string>();
  const dataMap = new Map<string, unknown>();
  const usedNames = new Set<string>();

  for (const [json, { key, value, count }] of occurrences) {
    if (count < 2) continue;
    if (!isValidIdentifier(key)) continue;

    let name = key;
    if (usedNames.has(name)) {
      let i = 2;
      while (usedNames.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    usedNames.add(name);
    result.set(json, name);
    dataMap.set(name, value);
  }

  _sharedValueData = dataMap;
  return result;
}

/**
 * Check if a value matches a shared const. Returns the const name or null.
 */
function getSharedConstName(value: unknown): string | null {
  if (_sharedValues.size === 0) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const json = canonicalJson(value);
  const name = _sharedValues.get(json) ?? null;
  if (name !== null) {
    _usedSharedValues.add(name);
  }
  return name;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generateWorkflowCode(workflow: N8nWorkflowInput): GenerateResult {
  const errors: string[] = [];

  // Build graph
  const nodeMap = new Map<string, GraphNode>();
  for (const node of workflow.nodes) {
    const dslKind = N8N_TYPE_TO_DSL_KIND[node.type] ?? null;
    nodeMap.set(node.name, {
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      parameters: stripEmptyOptions(normalizeParameters(node.type, node.typeVersion, node.parameters)),
      credentials: node.credentials,
      dslKind,
      isTrigger: TRIGGER_N8N_TYPES.has(node.type),
      isControlFlow: CONTROL_FLOW_TYPES.has(node.type),
    });
  }

  // Collect shared values for const extraction
  _sharedValues = collectSharedValues(nodeMap);
  _usedSharedValues = new Set();
  _usedN8nGlobals = new Set();
  _referencedTriggers = new Set();

  // Build adjacency
  const adjacency = buildAdjacency(workflow.connections);
  const loopBackEdges = detectLoopBackEdges(adjacency, nodeMap);
  const reverseAdj = buildReverseAdjacency(adjacency, loopBackEdges);

  // Identify triggers
  const triggers = workflow.nodes.filter((n) => TRIGGER_N8N_TYPES.has(n.type));
  if (triggers.length === 0) {
    errors.push("No trigger nodes found in workflow");
    return { code: null, errors };
  }

  // Build trigger reference map for $('Trigger Name') → param name replacement
  _triggerRefMap = buildTriggerRefMap(triggers);

  // Validate all action nodes are supported
  for (const node of workflow.nodes) {
    if (TRIGGER_N8N_TYPES.has(node.type) || CONTROL_FLOW_TYPES.has(node.type)) {
      continue;
    }
    if (!N8N_TYPE_TO_DSL_KIND[node.type]) {
      errors.push(`Unsupported node type: ${node.type} (node: ${node.name})`);
    }
  }
  if (errors.length > 0) {
    return { code: null, errors };
  }

  // Find the first nodes after triggers (all triggers converge to same execution graph)
  const triggerNames = new Set(triggers.map((t) => t.name));
  const firstNodes = new Set<string>();
  for (const triggerName of triggerNames) {
    const outputs = adjacency.get(triggerName);
    if (outputs) {
      for (const targets of outputs.values()) {
        for (const target of targets) {
          firstNodes.add(target);
        }
      }
    }
  }

  // Generate trigger code
  const triggerLines = triggers.map((t) => generateTriggerCall(t, nodeMap.get(t.name)!));

  // Generate execute body by walking the graph
  const visited = new Set<string>(triggerNames);
  const bodyLines: string[] = [];

  // Walk from firstNodes in order
  const orderedFirstNodes = sortNodesByPosition(
    [...firstNodes],
    workflow.nodes,
  );

  generateStatements(
    orderedFirstNodes,
    nodeMap,
    adjacency,
    reverseAdj,
    visited,
    bodyLines,
    2,
    errors,
  );

  if (errors.length > 0) {
    return { code: null, errors };
  }

  // Assemble output
  const lines: string[] = [];

  // Build dynamic import list based on which n8n globals were referenced
  const imports = ["n", "workflow"];
  // Sort for deterministic output
  for (const name of [..._usedN8nGlobals].sort()) {
    imports.push(name);
  }
  lines.push(`import { ${imports.join(", ")} } from "../src/dsl";`);
  lines.push("");

  // Generate const declarations for shared values (only those actually referenced)
  if (_sharedValues.size > 0) {
    const sortedConsts = [..._sharedValueData.entries()]
      .filter(([constName]) => _usedSharedValues.has(constName))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [constName, value] of sortedConsts) {
      // Temporarily disable shared values to serialize the const value as a plain literal
      const saved = _sharedValues;
      _sharedValues = new Map();
      lines.push(`const ${constName} = ${serializeValue(value, 0)};`);
      _sharedValues = saved;
    }
    if (sortedConsts.length > 0) {
      lines.push("");
    }
  }
  lines.push("export default workflow({");
  lines.push(`  name: ${JSON.stringify(workflow.name)},`);

  // Settings (omit if empty)
  if (workflow.settings && Object.keys(workflow.settings).length > 0) {
    lines.push(`  settings: ${serializeObject(workflow.settings, 2)},`);
  }

  // Triggers
  if (triggers.length === 1) {
    lines.push(`  triggers: [${triggerLines[0]}],`);
  } else {
    lines.push("  triggers: [");
    for (const line of triggerLines) {
      lines.push(`    ${line},`);
    }
    lines.push("  ],");
  }

  // Execute (with trigger parameter references if any)
  const executeParams: string[] = [];
  if (_referencedTriggers.size > 0) {
    const maxIndex = Math.max(..._referencedTriggers);
    for (let i = 0; i <= maxIndex; i++) {
      const trigger = triggers[i];
      const ref = trigger ? _triggerRefMap.get(trigger.name) : undefined;
      executeParams.push(ref?.paramName ?? "_");
    }
  }
  if (executeParams.length > 0) {
    lines.push(`  execute(${executeParams.join(", ")}) {`);
  } else {
    lines.push("  execute() {");
  }
  lines.push(...bodyLines);
  lines.push("  },");
  lines.push("});");
  lines.push("");

  // Cleanup module-level state
  _sharedValues = new Map();
  _sharedValueData = new Map();
  _usedSharedValues = new Set();
  _usedN8nGlobals = new Set();
  _triggerRefMap = new Map();
  _referencedTriggers = new Set();

  return { code: lines.join("\n"), errors: [] };
}

// ── Graph building ────────────────────────────────────────────────────────────

function buildAdjacency(connections: N8nConnectionsInput): AdjacencyMap {
  const adj: AdjacencyMap = new Map();

  for (const [fromNode, conn] of Object.entries(connections)) {
    if (!conn?.main) {
      continue;
    }

    const outputMap = adj.get(fromNode) ?? new Map<number, string[]>();
    adj.set(fromNode, outputMap);

    for (let outputIndex = 0; outputIndex < conn.main.length; outputIndex++) {
      const items = conn.main[outputIndex];
      if (!items) {
        continue;
      }
      const targets = outputMap.get(outputIndex) ?? [];
      outputMap.set(outputIndex, targets);
      for (const item of items) {
        targets.push(item.node);
      }
    }
  }

  return adj;
}

function buildReverseAdjacency(adj: AdjacencyMap, loopBackEdges: LoopBackEdges): ReverseAdjacencyMap {
  const reverse: ReverseAdjacencyMap = new Map();

  for (const [from, outputs] of adj) {
    for (const targets of outputs.values()) {
      for (const target of targets) {
        // Skip loop-back edges from reverse adjacency so they don't block traversal
        if (loopBackEdges.has(`${from}->${target}`)) {
          continue;
        }
        const sources = reverse.get(target) ?? new Set<string>();
        reverse.set(target, sources);
        sources.add(from);
      }
    }
  }

  return reverse;
}

/**
 * Detect loop-back edges: edges that go from a node back to a splitInBatches node.
 * These are identified as edges where the target is a splitInBatches node and the
 * source is reachable from that splitInBatches's output index 1 (loop body).
 */
function detectLoopBackEdges(
  adj: AdjacencyMap,
  nodeMap: Map<string, GraphNode>,
): LoopBackEdges {
  const loopBackEdges: LoopBackEdges = new Set();

  for (const [nodeName, node] of nodeMap) {
    if (node.type !== "n8n-nodes-base.splitInBatches") {
      continue;
    }

    // Find all edges pointing back to this splitInBatches node
    for (const [from, outputs] of adj) {
      for (const targets of outputs.values()) {
        for (const target of targets) {
          if (target === nodeName && from !== nodeName) {
            // Check if `from` is reachable from the loop body output (index 1)
            const loopBodyStart = adj.get(nodeName)?.get(1) ?? [];
            if (loopBodyStart.length > 0 && isReachableWithout(from, loopBodyStart, adj, nodeName)) {
              loopBackEdges.add(`${from}->${target}`);
            }
          }
        }
      }
    }
  }

  return loopBackEdges;
}

/**
 * Check if `target` is reachable from any of `startNodes` without going through `excludeNode`.
 */
function isReachableWithout(
  target: string,
  startNodes: string[],
  adj: AdjacencyMap,
  excludeNode: string,
): boolean {
  const visited = new Set<string>();
  const queue = [...startNodes];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) {
      return true;
    }
    if (visited.has(current) || current === excludeNode) {
      continue;
    }
    visited.add(current);

    const outputs = adj.get(current);
    if (outputs) {
      for (const targets of outputs.values()) {
        for (const t of targets) {
          if (!visited.has(t)) {
            queue.push(t);
          }
        }
      }
    }
  }

  return false;
}

// ── Statement generation ──────────────────────────────────────────────────────

function generateStatements(
  nodeNames: string[],
  nodeMap: Map<string, GraphNode>,
  adj: AdjacencyMap,
  reverseAdj: ReverseAdjacencyMap,
  visited: Set<string>,
  lines: string[],
  indent: number,
  errors: string[],
): void {
  // Check for fan-out: if multiple unvisited nodes are passed in,
  // they represent parallel branches from the same source
  const unvisitedNodes = nodeNames.filter((n) => !visited.has(n));
  if (unvisitedNodes.length > 1) {
    // Check if all nodes are ready (all predecessors visited)
    const readyNodes = unvisitedNodes.filter((nodeName) => {
      const predecessors = reverseAdj.get(nodeName);
      if (!predecessors) return true;
      return [...predecessors].every((p) => visited.has(p));
    });

    if (readyNodes.length > 1) {
      generateParallelFromFanout(readyNodes, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
      return;
    }
  }

  for (const nodeName of nodeNames) {
    if (visited.has(nodeName)) {
      continue;
    }

    // Check all predecessors (except loop-back edges) are visited
    const predecessors = reverseAdj.get(nodeName);
    if (predecessors) {
      const unvisitedPreds = [...predecessors].filter((p) => !visited.has(p));
      // If this node has unvisited predecessors, it's a merge point. Skip for now;
      // it will be visited when all predecessors converge.
      if (unvisitedPreds.length > 0) {
        continue;
      }
    }

    const node = nodeMap.get(nodeName);
    if (!node) {
      continue;
    }

    visited.add(nodeName);

    if (node.type === "n8n-nodes-base.if") {
      generateIfStatement(nodeName, node, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
    } else if (node.type === "n8n-nodes-base.splitInBatches") {
      generateLoopStatement(nodeName, node, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
    } else if (node.type === "n8n-nodes-base.switch") {
      generateSwitchStatement(nodeName, node, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
    } else {
      generateNodeCall(nodeName, node, lines, indent);
      // Continue to successors
      const successors = getSuccessors(nodeName, adj, 0);
      if (successors.length > 1) {
        // Fan-out → parallel
        generateParallelFromFanout(successors, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
      } else {
        generateStatements(successors, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
      }
    }
  }
}

function generateNodeCall(
  nodeName: string,
  node: GraphNode,
  lines: string[],
  indent: number,
): void {
  if (!node.dslKind) {
    return;
  }

  const params = stripEmptyOptions(normalizeParameters(node.type, node.typeVersion, node.parameters));
  const pad = " ".repeat(indent);
  const paramsStr = serializeObject(params, indent);

  // Build options (credentials, name) — but use @name JSDoc for space-containing names
  const hasSpaceInName = nodeHasSpaceName(node);
  const options = buildNodeOptions(node, hasSpaceInName);

  // Emit @name JSDoc if the node name contains spaces
  if (hasSpaceInName) {
    lines.push(`${pad}/** @name ${node.name} */`);
  }

  if (options) {
    lines.push(`${pad}n.${node.dslKind}(${paramsStr}, ${serializeObject(options, indent)});`);
  } else if (Object.keys(params).length === 0 && isOptionalParamsNode(node.dslKind)) {
    lines.push(`${pad}n.${node.dslKind}();`);
  } else {
    lines.push(`${pad}n.${node.dslKind}(${paramsStr});`);
  }
}

function generateIfStatement(
  nodeName: string,
  node: GraphNode,
  nodeMap: Map<string, GraphNode>,
  adj: AdjacencyMap,
  reverseAdj: ReverseAdjacencyMap,
  visited: Set<string>,
  lines: string[],
  indent: number,
  errors: string[],
): void {
  const pad = " ".repeat(indent);
  const params = normalizeParameters(node.type, node.typeVersion, node.parameters);

  // Extract expression - either from normalised DSL form or raw n8n conditions
  let conditionStr: string;
  if (typeof params.expression === "string") {
    conditionStr = `n.expr(${JSON.stringify(params.expression)})`;
  } else {
    // Native n8n conditions format - pass the raw conditions through as a serialized
    // n.expr() with a synthesized expression that captures the semantics
    const syntheticExpr = synthesizeExpressionFromConditions(node.parameters);
    if (syntheticExpr) {
      conditionStr = `n.expr(${JSON.stringify(syntheticExpr)})`;
    } else {
      // Fall back to passing the raw conditions as parameters
      conditionStr = `n.expr("={{/* complex condition - review manually */}}")`;
    }
  }

  const trueSuccessors = getSuccessors(nodeName, adj, 0);
  const falseSuccessors = getSuccessors(nodeName, adj, 1);

  // Find convergence point (nodes reachable from both branches)
  const trueReachable = collectReachable(trueSuccessors, adj, nodeMap);
  const falseReachable = collectReachable(falseSuccessors, adj, nodeMap);
  const convergence = findConvergenceNodes(trueReachable, falseReachable);

  // Mark convergence nodes as "not yet visited" so they get visited after
  const trueVisited = new Set(visited);
  const falseVisited = new Set(visited);

  // Generate condition
  lines.push(`${pad}if (${conditionStr}) {`);

  // True branch
  const trueBranchNodes = trueSuccessors.filter((n) => !convergence.has(n));
  generateStatements(
    trueBranchNodes,
    nodeMap,
    adj,
    reverseAdj,
    trueVisited,
    lines,
    indent + 2,
    errors,
  );

  // False branch
  const falseBranchNodes = falseSuccessors.filter((n) => !convergence.has(n));
  if (falseBranchNodes.length > 0) {
    lines.push(`${pad}} else {`);
    generateStatements(
      falseBranchNodes,
      nodeMap,
      adj,
      reverseAdj,
      falseVisited,
      lines,
      indent + 2,
      errors,
    );
  }

  lines.push(`${pad}}`);

  // Merge visited sets
  for (const v of trueVisited) {
    visited.add(v);
  }
  for (const v of falseVisited) {
    visited.add(v);
  }

  // Continue with convergence nodes
  if (convergence.size > 0) {
    const orderedConvergence = [...convergence];
    generateStatements(orderedConvergence, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
  }
}

/**
 * Synthesize an n8n expression string from native conditions format.
 *
 * Handles common patterns:
 *   - string contains/notContains
 *   - string equals/notEquals
 *   - boolean true/false
 *   - number comparisons
 *
 * Returns null if the conditions are too complex to synthesize.
 */
function synthesizeExpressionFromConditions(parameters: JsonObject): string | null {
  const conditions = parameters.conditions;
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) {
    return null;
  }

  const condObj = conditions as Record<string, unknown>;
  const condArray = condObj.conditions;
  if (!Array.isArray(condArray) || condArray.length === 0) {
    return null;
  }

  const combinator = (condObj.combinator as string) ?? "and";
  const parts: string[] = [];

  for (const cond of condArray as Array<Record<string, unknown>>) {
    const leftValue = cond.leftValue as string | undefined;
    const rightValue = cond.rightValue;
    const operator = cond.operator as Record<string, string> | undefined;

    if (!leftValue || !operator) {
      return null;
    }

    const opType = operator.type ?? "";
    const opOp = operator.operation ?? "";

    // Extract the inner expression from ={{ ... }}
    const leftExpr = unwrapExpression(leftValue);
    if (!leftExpr) {
      return null;
    }

    const part = synthesizeSingleCondition(leftExpr, opType, opOp, rightValue);
    if (!part) {
      return null;
    }

    parts.push(part);
  }

  if (parts.length === 0) {
    return null;
  }

  const joiner = combinator === "or" ? " || " : " && ";
  const body = parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(joiner);
  return `={{${body}}}`;
}

function synthesizeSingleCondition(
  leftExpr: string,
  opType: string,
  opOp: string,
  rightValue: unknown,
): string | null {
  if (opType === "boolean" && opOp === "true") {
    return leftExpr;
  }
  if (opType === "boolean" && opOp === "false") {
    return `!${leftExpr}`;
  }

  if (opType === "string") {
    const rightStr = typeof rightValue === "string" ? JSON.stringify(rightValue) : String(rightValue);
    switch (opOp) {
      case "equals":
        return `${leftExpr} === ${rightStr}`;
      case "notEquals":
        return `${leftExpr} !== ${rightStr}`;
      case "contains":
        return `${leftExpr}.includes(${rightStr})`;
      case "notContains":
        return `!${leftExpr}.includes(${rightStr})`;
      case "startsWith":
        return `${leftExpr}.startsWith(${rightStr})`;
      case "endsWith":
        return `${leftExpr}.endsWith(${rightStr})`;
      default:
        return null;
    }
  }

  if (opType === "number") {
    const rightNum = typeof rightValue === "number" ? String(rightValue) : String(rightValue);
    switch (opOp) {
      case "equals":
        return `${leftExpr} === ${rightNum}`;
      case "notEquals":
        return `${leftExpr} !== ${rightNum}`;
      case "gt":
        return `${leftExpr} > ${rightNum}`;
      case "gte":
        return `${leftExpr} >= ${rightNum}`;
      case "lt":
        return `${leftExpr} < ${rightNum}`;
      case "lte":
        return `${leftExpr} <= ${rightNum}`;
      default:
        return null;
    }
  }

  return null;
}

function unwrapExpression(value: string): string | null {
  if (value.startsWith("={{") && value.endsWith("}}")) {
    return value.slice(3, -2).trim();
  }
  // Not an expression, treat as a literal reference
  return null;
}

function generateLoopStatement(
  nodeName: string,
  _node: GraphNode,
  nodeMap: Map<string, GraphNode>,
  adj: AdjacencyMap,
  reverseAdj: ReverseAdjacencyMap,
  visited: Set<string>,
  lines: string[],
  indent: number,
  errors: string[],
): void {
  const pad = " ".repeat(indent);

  // splitInBatches: output 0 = done, output 1 = loop body
  const doneSuccessors = getSuccessors(nodeName, adj, 0);
  const loopSuccessors = getSuccessors(nodeName, adj, 1);

  lines.push(`${pad}for (const _ of n.loop({})) {`);

  // Walk the loop body. We need to track which nodes are in the loop body
  // (they eventually loop back to the splitInBatches node).
  const loopVisited = new Set(visited);
  // Allow the loop node itself to be a valid back-edge target
  loopVisited.delete(nodeName);

  generateLoopBody(
    loopSuccessors,
    nodeName,
    nodeMap,
    adj,
    reverseAdj,
    loopVisited,
    lines,
    indent + 2,
    errors,
  );

  lines.push(`${pad}}`);

  // Merge visited
  for (const v of loopVisited) {
    visited.add(v);
  }
  visited.add(nodeName);

  // Continue with done successors
  generateStatements(doneSuccessors, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
}

function generateLoopBody(
  nodeNames: string[],
  loopNodeName: string,
  nodeMap: Map<string, GraphNode>,
  adj: AdjacencyMap,
  reverseAdj: ReverseAdjacencyMap,
  visited: Set<string>,
  lines: string[],
  indent: number,
  errors: string[],
): void {
  for (const nodeName of nodeNames) {
    if (visited.has(nodeName) || nodeName === loopNodeName) {
      continue;
    }

    // Check predecessors
    const predecessors = reverseAdj.get(nodeName);
    if (predecessors) {
      const unvisitedPreds = [...predecessors].filter(
        (p) => !visited.has(p) && p !== loopNodeName,
      );
      if (unvisitedPreds.length > 0) {
        continue;
      }
    }

    const node = nodeMap.get(nodeName);
    if (!node) {
      continue;
    }

    visited.add(nodeName);

    if (node.type === "n8n-nodes-base.if") {
      generateIfStatement(nodeName, node, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
    } else if (node.type === "n8n-nodes-base.switch") {
      generateSwitchStatement(nodeName, node, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
    } else {
      generateNodeCall(nodeName, node, lines, indent);
      const successors = getSuccessors(nodeName, adj, 0);
      // Filter out the loop-back edge
      const nonLoopBack = successors.filter((s) => s !== loopNodeName);
      if (nonLoopBack.length > 1) {
        generateParallelFromFanout(nonLoopBack, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
      } else {
        generateLoopBody(nonLoopBack, loopNodeName, nodeMap, adj, reverseAdj, visited, lines, indent, errors);
      }
    }
  }
}

function generateSwitchStatement(
  nodeName: string,
  node: GraphNode,
  nodeMap: Map<string, GraphNode>,
  adj: AdjacencyMap,
  reverseAdj: ReverseAdjacencyMap,
  visited: Set<string>,
  lines: string[],
  indent: number,
  errors: string[],
): void {
  const pad = " ".repeat(indent);
  const params = normalizeParameters(node.type, node.typeVersion, node.parameters);

  const expression = typeof params.expression === "string" ? params.expression : null;
  const cases = Array.isArray(params.cases) ? params.cases as Array<{ value: unknown }> : null;

  if (!expression || !cases) {
    errors.push(`Switch node "${nodeName}" has unsupported format`);
    return;
  }

  // Collect all branch successors
  const allBranchNodes = new Set<string>();
  const branchSuccessors: string[][] = [];
  for (let i = 0; i <= cases.length; i++) {
    const successors = getSuccessors(nodeName, adj, i);
    branchSuccessors.push(successors);
    for (const s of successors) {
      allBranchNodes.add(s);
    }
  }

  // Find convergence
  const reachableSets = branchSuccessors.map((s) => collectReachable(s, adj, nodeMap));
  const convergence = findMultiConvergenceNodes(reachableSets);

  lines.push(`${pad}switch (n.expr(${JSON.stringify(expression)})) {`);

  for (let i = 0; i < cases.length; i++) {
    const caseValue = cases[i]!.value;
    const caseSuccessors = (branchSuccessors[i] ?? []).filter((n) => !convergence.has(n));
    lines.push(`${pad}  case ${serializeLiteral(caseValue)}:`);

    const branchVisited = new Set(visited);
    generateStatements(caseSuccessors, nodeMap, adj, reverseAdj, branchVisited, lines, indent + 4, errors);
    lines.push(`${pad}    break;`);

    for (const v of branchVisited) {
      visited.add(v);
    }
  }

  // Default case (unmatched output)
  const defaultSuccessors = (branchSuccessors[cases.length] ?? []).filter((n) => !convergence.has(n));
  if (defaultSuccessors.length > 0) {
    lines.push(`${pad}  default:`);
    const defaultVisited = new Set(visited);
    generateStatements(defaultSuccessors, nodeMap, adj, reverseAdj, defaultVisited, lines, indent + 4, errors);
    for (const v of defaultVisited) {
      visited.add(v);
    }
  }

  lines.push(`${pad}}`);

  // Continue with convergence
  if (convergence.size > 0) {
    generateStatements([...convergence], nodeMap, adj, reverseAdj, visited, lines, indent, errors);
  }
}

function generateParallelFromFanout(
  targets: string[],
  nodeMap: Map<string, GraphNode>,
  adj: AdjacencyMap,
  reverseAdj: ReverseAdjacencyMap,
  visited: Set<string>,
  lines: string[],
  indent: number,
  errors: string[],
): void {
  const pad = " ".repeat(indent);

  // Collect reachable from each branch
  const branchReachable = targets.map((t) => collectReachable([t], adj, nodeMap));
  const convergence = findMultiConvergenceNodes(branchReachable);

  lines.push(`${pad}n.parallel(`);

  for (const target of targets) {
    const branchVisited = new Set(visited);
    const branchLines: string[] = [];

    if (!convergence.has(target)) {
      generateStatements(
        [target],
        nodeMap,
        adj,
        reverseAdj,
        branchVisited,
        branchLines,
        indent + 4,
        errors,
      );
    }

    lines.push(`${pad}  () => {`);
    lines.push(...branchLines);
    lines.push(`${pad}  },`);

    for (const v of branchVisited) {
      visited.add(v);
    }
  }

  lines.push(`${pad});`);

  // Continue with convergence
  if (convergence.size > 0) {
    generateStatements([...convergence], nodeMap, adj, reverseAdj, visited, lines, indent, errors);
  }
}

// ── Trigger code generation ───────────────────────────────────────────────────

function generateTriggerCall(node: N8nNodeInput, graphNode: GraphNode): string {
  if (!graphNode.dslKind) {
    return `/* unsupported trigger: ${node.type} */`;
  }

  const params = stripEmptyOptions(normalizeParameters(node.type, node.typeVersion, node.parameters));
  const options = buildNodeOptions(graphNode);

  if (options) {
    const paramsStr = serializeObject(params, 4);
    const optionsStr = serializeObject(options, 4);
    return `n.${graphNode.dslKind}(${paramsStr}, ${optionsStr})`;
  }

  if (Object.keys(params).length === 0 && isOptionalParamsNode(graphNode.dslKind)) {
    return `n.${graphNode.dslKind}()`;
  }

  return `n.${graphNode.dslKind}(${serializeObject(params, 4)})`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSuccessors(nodeName: string, adj: AdjacencyMap, outputIndex: number): string[] {
  return adj.get(nodeName)?.get(outputIndex) ?? [];
}

function collectReachable(
  startNodes: string[],
  adj: AdjacencyMap,
  nodeMap: Map<string, GraphNode>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [...startNodes];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    const outputs = adj.get(current);
    if (outputs) {
      for (const targets of outputs.values()) {
        for (const target of targets) {
          if (!reachable.has(target)) {
            queue.push(target);
          }
        }
      }
    }
  }

  return reachable;
}

function findConvergenceNodes(
  setA: Set<string>,
  setB: Set<string>,
): Set<string> {
  const convergence = new Set<string>();
  for (const node of setA) {
    if (setB.has(node)) {
      convergence.add(node);
    }
  }
  return convergence;
}

function findMultiConvergenceNodes(sets: Set<string>[]): Set<string> {
  if (sets.length < 2) {
    return new Set();
  }

  // A node converges if it appears in ALL sets
  const first = sets[0]!;
  const convergence = new Set<string>();

  for (const node of first) {
    if (sets.every((s) => s.has(node))) {
      convergence.add(node);
    }
  }

  return convergence;
}

function sortNodesByPosition(
  nodeNames: string[],
  nodes: N8nNodeInput[],
): string[] {
  const posMap = new Map<string, [number, number]>();
  for (const node of nodes) {
    if (node.position) {
      posMap.set(node.name, node.position);
    }
  }

  return [...nodeNames].sort((a, b) => {
    const posA = posMap.get(a) ?? [0, 0];
    const posB = posMap.get(b) ?? [0, 0];
    // Sort by x first (left to right), then y (top to bottom)
    if (posA[0] !== posB[0]) {
      return posA[0] - posB[0];
    }
    return posA[1] - posB[1];
  });
}

function buildNodeOptions(node: GraphNode, suppressName = false): JsonObject | null {
  const options: JsonObject = {};

  if (node.credentials && Object.keys(node.credentials).length > 0) {
    options.credentials = node.credentials;
  }

  // Only set name option if it's not auto-generated (dslKind_N pattern)
  // and not suppressed (when using @name JSDoc instead)
  if (!suppressName && node.dslKind) {
    const autoNamePattern = new RegExp(`^${node.dslKind}_\\d+$`);
    if (!autoNamePattern.test(node.name)) {
      options.name = node.name;
    }
  }

  return Object.keys(options).length > 0 ? options : null;
}

/** Returns true if the node has a custom name (not auto-generated) that contains spaces. */
function nodeHasSpaceName(node: GraphNode): boolean {
  if (!node.dslKind) {
    return false;
  }
  const autoNamePattern = new RegExp(`^${node.dslKind}_\\d+$`);
  if (autoNamePattern.test(node.name)) {
    return false;
  }
  return node.name.includes(" ");
}

/**
 * n8n の "optional extras" キー (`options`, `additionalFields`) が
 * 空オブジェクト、または全値が空文字の場合に除去する。
 */
const STRIPPABLE_PARAM_KEYS = new Set(["options", "additionalFields"]);

function stripEmptyOptions(params: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(params)) {
    if (STRIPPABLE_PARAM_KEYS.has(key) && isEffectivelyEmptyExtras(value)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Returns true for `{}` or objects where all values are empty strings / null / undefined.
 */
function isEffectivelyEmptyExtras(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const values = Object.values(obj);
  if (values.length === 0) return true;
  return values.every((v) => v === "" || v === null || v === undefined);
}

function isOptionalParamsNode(dslKind: string): boolean {
  return dslKind === "manualTrigger" || dslKind === "noOp";
}

// ── Trigger reference helpers ─────────────────────────────────────────────────

/**
 * Build a mapping from trigger display name → execute parameter variable name.
 */
function buildTriggerRefMap(triggers: N8nNodeInput[]): Map<string, { paramName: string; triggerIndex: number }> {
  const map = new Map<string, { paramName: string; triggerIndex: number }>();
  const usedNames = new Set<string>();

  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i]!;
    const dslKind = N8N_TYPE_TO_DSL_KIND[trigger.type];
    if (!dslKind) continue;

    let paramName = dslKind.endsWith("Trigger")
      ? dslKind.slice(0, -"Trigger".length)
      : dslKind;
    if (usedNames.has(paramName)) {
      let suffix = 2;
      while (usedNames.has(`${paramName}${suffix}`)) suffix++;
      paramName = `${paramName}${suffix}`;
    }
    usedNames.add(paramName);

    map.set(trigger.name, { paramName, triggerIndex: i });
  }

  return map;
}

/**
 * Replace `$('Trigger Name').item.json` / `.first().json` / `.json` patterns
 * in an expression body with the corresponding execute parameter name.
 */
function replaceTriggerReferences(body: string): { replaced: string; hadReplacement: boolean } {
  let replaced = body;
  let hadReplacement = false;

  for (const [triggerName, { paramName, triggerIndex }] of _triggerRefMap) {
    const escaped = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\$\\(\\s*['"]${escaped}['"]\\s*\\)(?:\\.item)?(?:\\.first\\(\\))?\\.json`,
      "g",
    );
    const newBody = replaced.replace(pattern, paramName);
    if (newBody !== replaced) {
      _referencedTriggers.add(triggerIndex);
      replaced = newBody;
      hadReplacement = true;
    }
  }

  return { replaced, hadReplacement };
}

/**
 * Check if the body is a valid identifier or member expression (e.g. `trigger.start.dateTime`).
 * Used to allow unwrapping of simple trigger parameter references.
 */
function isSimpleParamReference(body: string): boolean {
  try {
    const wrapped = `const _ = (${body});`;
    const result = oxcParseSync("expr.ts", wrapped, {
      lang: "ts",
      sourceType: "module",
    });

    if (result.errors.length > 0) {
      return false;
    }

    const stmt = result.program.body[0];
    if (!stmt || stmt.type !== "VariableDeclaration") {
      return false;
    }

    const declarations = (stmt as { declarations: Array<{ init: { type: string; expression?: { type: string } } | null }> }).declarations;
    const init = declarations[0]?.init;
    if (!init) {
      return false;
    }

    const expr = init.type === "ParenthesizedExpression" && init.expression
      ? init.expression
      : init;

    return expr.type === "Identifier" || expr.type === "MemberExpression";
  } catch {
    return false;
  }
}

// ── Expression unwrapping ─────────────────────────────────────────────────────

/**
 * n8n expression-only globals that cannot be used as raw TS code.
 * These are available only inside `={{...}}` at n8n runtime and have no
 * corresponding DSL export.
 */
const N8N_EXPRESSION_ONLY_GLOBALS =
  /\$(json|node|input|execution|prevNode|runIndex|workflow|now|today|jmespath)\b/;

/**
 * n8n globals that we export from the DSL as compile-time stubs.
 */
const N8N_DSL_GLOBALS = new Set(["DateTime", "Duration", "Interval"]);

/**
 * Compound expression AST types that the compiler can serialise back into
 * `={{...}}` expression strings.
 */
const COMPOUND_EXPRESSION_TYPES = new Set([
  "CallExpression",
  "NewExpression",
  "BinaryExpression",
  "UnaryExpression",
  "LogicalExpression",
  "ConditionalExpression",
]);

/**
 * Try to unwrap an n8n expression string (`={{...}}`) into raw JavaScript
 * that the compiler can serialise back.
 *
 * Returns the raw JS expression body, or `null` if the value should stay
 * as a quoted string.
 */
function tryUnwrapExpression(value: string): string | null {
  if (!value.startsWith("={{") || !value.endsWith("}}")) {
    return null;
  }

  let body = value.slice(3, -2).trim();
  if (!body) {
    return null;
  }

  // Replace $('Trigger Name').item.json → paramName before further checks
  const { replaced, hadReplacement } = replaceTriggerReferences(body);
  body = replaced;

  // Don't unwrap expressions that use n8n-only globals ($json, $node, etc.)
  if (N8N_EXPRESSION_ONLY_GLOBALS.test(body)) {
    return null;
  }

  // Parse the body as JavaScript and check if it's a compound expression
  // Also allow simple param references (e.g. `trigger.start.dateTime`)
  const isCompound = isCompoundJSExpression(body);
  if (!isCompound) {
    if (hadReplacement && isSimpleParamReference(body)) {
      trackN8nGlobals(body);
      return body;
    }
    return null;
  }

  // Track which n8n globals are referenced so the import line can include them
  trackN8nGlobals(body);

  return body;
}

/**
 * Parses a string as a JavaScript expression and returns true if the
 * top-level AST node is a compound expression type.
 */
function isCompoundJSExpression(body: string): boolean {
  try {
    const wrapped = `const _ = (${body});`;
    const result = oxcParseSync("expr.ts", wrapped, {
      lang: "ts",
      sourceType: "module",
    });

    if (result.errors.length > 0) {
      return false;
    }

    const stmt = result.program.body[0];
    if (!stmt || stmt.type !== "VariableDeclaration") {
      return false;
    }

    const declarations = (stmt as { declarations: Array<{ init: { type: string; expression?: { type: string } } | null }> }).declarations;
    const init = declarations[0]?.init;
    if (!init) {
      return false;
    }

    // Unwrap the parentheses we added
    const expr = init.type === "ParenthesizedExpression" && init.expression
      ? init.expression
      : init;

    return COMPOUND_EXPRESSION_TYPES.has(expr.type);
  } catch {
    return false;
  }
}

/**
 * Scan an expression body for known n8n globals and record them.
 */
function trackN8nGlobals(body: string): void {
  for (const name of N8N_DSL_GLOBALS) {
    if (new RegExp(`\\b${name}\\b`).test(body)) {
      _usedN8nGlobals.add(name);
    }
  }

  // Detect $() function usage (but not $json, $node, etc.)
  if (/\$\s*\(/.test(body)) {
    _usedN8nGlobals.add("$");
  }
}

// ── Serialization helpers ─────────────────────────────────────────────────────

function serializeObject(obj: JsonObject, baseIndent: number): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return "{}";
  }

  // Simple one-line format for small objects
  if (isSimpleObject(obj)) {
    const inner = entries
      .map(([key, value]) => serializeEntry(key, value, baseIndent))
      .join(", ");
    return `{ ${inner} }`;
  }

  // Multi-line format
  const pad = " ".repeat(baseIndent);
  const innerPad = " ".repeat(baseIndent + 2);
  const lineEntries = entries.map(
    ([key, value]) => `${innerPad}${serializeEntry(key, value, baseIndent + 2)},`,
  );
  return `{\n${lineEntries.join("\n")}\n${pad}}`;
}

/**
 * Serialize a single object entry (key: value), using shorthand if the value
 * matches a shared const whose name equals the property key.
 */
function serializeEntry(key: string, value: unknown, indent: number): string {
  const constName = getSharedConstName(value);
  if (constName !== null) {
    if (constName === key) {
      return safeKey(key); // shorthand: { foo } instead of { foo: foo }
    }
    return `${safeKey(key)}: ${constName}`;
  }
  return `${safeKey(key)}: ${serializeValue(value, indent)}`;
}

function serializeValue(value: unknown, indent: number): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    // Try to unwrap n8n expression to raw JS
    const unwrapped = tryUnwrapExpression(value);
    if (unwrapped !== null) {
      return unwrapped;
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return serializeArray(value, indent);
  }
  if (typeof value === "object") {
    // Check if this object matches a shared const
    const constName = getSharedConstName(value);
    if (constName !== null) {
      return constName;
    }
    return serializeObject(value as JsonObject, indent);
  }
  return JSON.stringify(value);
}

function serializeArray(arr: unknown[], indent: number): string {
  if (arr.length === 0) {
    return "[]";
  }

  if (arr.every((item) => typeof item !== "object" || item === null)) {
    return `[${arr.map((item) => serializeValue(item, indent)).join(", ")}]`;
  }

  const pad = " ".repeat(indent);
  const innerPad = " ".repeat(indent + 2);
  const items = arr.map((item) => `${innerPad}${serializeValue(item, indent + 2)},`);
  return `[\n${items.join("\n")}\n${pad}]`;
}

function serializeLiteral(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function safeKey(key: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

function isSimpleObject(obj: JsonObject): boolean {
  const entries = Object.entries(obj);
  if (entries.length > 4) {
    return false;
  }

  for (const [, value] of entries) {
    if (typeof value === "object" && value !== null) {
      // If this object would be replaced by a shared const, treat as simple
      if (getSharedConstName(value) !== null) {
        continue;
      }
      return false;
    }
    if (typeof value === "string" && value.length > 60) {
      return false;
    }
  }

  return true;
}
