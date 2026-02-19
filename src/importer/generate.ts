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
  connections?: N8nConnectionsInput;
  settings?: JsonObject;
};

export type N8nNodeInput = {
  name: string;
  type: string;
  typeVersion: number;
  parameters?: JsonObject;
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
  Record<string, N8nConnectionItem[][]>
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
  "n8n-nodes-base.formTrigger": "formTrigger",
  "n8n-nodes-base.formtrigger": "formTrigger",
  "n8n-nodes-base.executeWorkflowTrigger": "executeWorkflowTrigger",
  "n8n-nodes-base.executeworkflowtrigger": "executeWorkflowTrigger",
  "n8n-nodes-base.httpRequest": "httpRequest",
  "n8n-nodes-base.executeworkflow": "executeWorkflow",
  "n8n-nodes-base.executeWorkflow": "executeWorkflow",
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
  "n8n-nodes-base.googleSheets": "googleSheets",
  "n8n-nodes-base.itemLists": "itemLists",
  "@n8n/n8n-nodes-langchain.agent": "langchainAgent",
  "@n8n/n8n-nodes-langchain.lmChatGoogleVertex": "lmChatGoogleVertex",
};

const TRIGGER_N8N_TYPES = new Set([
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.googleCalendarTrigger",
  "n8n-nodes-base.formTrigger",
  "n8n-nodes-base.formtrigger",
  "n8n-nodes-base.executeWorkflowTrigger",
  "n8n-nodes-base.executeworkflowtrigger",
]);

const CONTROL_FLOW_TYPES = new Set([
  "n8n-nodes-base.if",
  "n8n-nodes-base.splitInBatches",
  "n8n-nodes-base.switch",
]);

/**
 * Default typeVersion values used by the compiler (mirrors lowering.ts DEFAULT_TYPE_VERSION).
 * Keyed by DSL kind. Nodes not listed here default to 1.
 */
const COMPILER_DEFAULT_TYPE_VERSION: Partial<Record<string, number>> = {
  scheduleTrigger: 1.2,
  httpRequest: 4.2,
  googleCalendar: 1.3,
  googleSheets: 4.5,
};

/**
 * Returns the compiler's default typeVersion for a given DSL kind.
 */
function getCompilerDefaultTypeVersion(dslKind: string): number {
  return COMPILER_DEFAULT_TYPE_VERSION[dslKind] ?? 1;
}

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
 * Maps non-trigger node display name → variable name.
 * Used to replace `$('Node Name').item.json.xxx` → `varName.xxx` in expressions
 * and to generate `const varName = n.xxx(...)` for referenced nodes.
 */
let _nodeRefMap: Map<string, string> = new Map();

/**
 * Maps code node display name → predecessor variable name for $input replacement in jsCode.
 * When a code node's jsCode contains `$input.first().json` or `$input.item.json`,
 * and it has a single predecessor, this maps the code node name to the predecessor's
 * variable name (either a trigger param name or a const variable name).
 */
let _codeInputRefMap: Map<string, string> = new Map();

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
    // n8n API may omit parameters/credentials for nodes with empty config
    const params = node.parameters ?? {};
    const creds = node.credentials ?? undefined;
    nodeMap.set(node.name, {
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      parameters: stripEmptyOptions(normalizeParameters(node.type, node.typeVersion, params)),
      credentials: creds,
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
  const adjacency = buildAdjacency(workflow.connections ?? {});
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

  // Collect non-main connections (e.g. ai_languageModel)
  const nonMainConnections = collectNonMainConnections(workflow.connections ?? {});

  // Determine nodes that are ONLY referenced via non-main connections (sub-nodes like ChatModels)
  // These should not be treated as unsupported — they'll be generated via n.connect()
  const nonMainNodeNames = new Set(nonMainConnections.map((c) => c.fromNode));

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

  // Build non-trigger node reference map for $('Node Name') → variable name replacement
  const referencedNodeNames = scanForNodeReferences(nodeMap, triggerNames);

  // Scan code nodes for $input references and register their predecessors as referenced
  const codeInputPredecessors = scanCodeNodeInputPredecessors(nodeMap, reverseAdj, triggerNames);
  for (const predName of codeInputPredecessors.values()) {
    if (!triggerNames.has(predName)) {
      referencedNodeNames.add(predName);
    }
  }

  _nodeRefMap = buildNodeRefMap(referencedNodeNames, nodeMap, _triggerRefMap);

  // Build code node → predecessor variable name map for $input replacement
  _codeInputRefMap = new Map();
  for (const [codeName, predName] of codeInputPredecessors) {
    if (triggerNames.has(predName)) {
      const trigRef = _triggerRefMap.get(predName);
      if (trigRef) {
        _codeInputRefMap.set(codeName, trigRef.paramName);
        _referencedTriggers.add(trigRef.triggerIndex);
      }
    } else {
      const varName = _nodeRefMap.get(predName);
      if (varName) {
        _codeInputRefMap.set(codeName, varName);
      }
    }
  }

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

  // Generate n.connect() calls for non-main connections
  const connectLines: string[] = [];
  if (nonMainConnections.length > 0) {
    connectLines.push("");

    for (const conn of nonMainConnections) {
      const sourceNode = nodeMap.get(conn.fromNode);
      if (!sourceNode || !sourceNode.dslKind) {
        continue;
      }

      // Generate the source node call inline within n.connect()
      const sourceParams = stripEmptyOptions(normalizeParameters(sourceNode.type, sourceNode.typeVersion, sourceNode.parameters));
      const sourceParamsStr = serializeObject(sourceParams, 6);
      const sourceOptions = buildNodeOptions(sourceNode);
      // Always include name for sub-nodes so the connection target can be resolved
      const sourceOptionsWithName: JsonObject = { ...(sourceOptions ?? {}) };
      if (!sourceOptionsWithName.name) {
        sourceOptionsWithName.name = sourceNode.name;
      }
      const sourceOptionsStr = serializeObject(sourceOptionsWithName, 6);

      const pad = "    ";
      connectLines.push(`${pad}n.connect(`);
      connectLines.push(`${pad}  n.${sourceNode.dslKind}(${sourceParamsStr}, ${sourceOptionsStr}),`);
      connectLines.push(`${pad}  ${JSON.stringify(conn.toNode)},`);
      connectLines.push(`${pad}  { type: ${JSON.stringify(conn.connectionType)} },`);
      connectLines.push(`${pad});`);
    }
  }

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
  lines.push(`import { ${imports.join(", ")} } from "n8n-compiler/dsl";`);
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
  if (connectLines.length > 0) {
    lines.push(...connectLines);
  }
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
  _nodeRefMap = new Map();
  _codeInputRefMap = new Map();

  return { code: lines.join("\n"), errors: [] };
}

// ── Graph building ────────────────────────────────────────────────────────────

function buildAdjacency(connections: N8nConnectionsInput): AdjacencyMap {
  const adj: AdjacencyMap = new Map();

  for (const [fromNode, connTypes] of Object.entries(connections)) {
    const mainConn = connTypes?.main;
    if (!mainConn) {
      continue;
    }

    const outputMap = adj.get(fromNode) ?? new Map<number, string[]>();
    adj.set(fromNode, outputMap);

    for (let outputIndex = 0; outputIndex < mainConn.length; outputIndex++) {
      const items = mainConn[outputIndex];
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

/** Represents a non-main connection (e.g. ai_languageModel, ai_tool). */
type NonMainConnection = {
  fromNode: string;
  toNode: string;
  connectionType: string;
};

/**
 * Collect all non-main connections from the workflow connections input.
 * These are connections with types other than "main" (e.g. "ai_languageModel").
 */
function collectNonMainConnections(connections: N8nConnectionsInput): NonMainConnection[] {
  const result: NonMainConnection[] = [];

  for (const [fromNode, connTypes] of Object.entries(connections)) {
    for (const [connType, outputs] of Object.entries(connTypes ?? {})) {
      if (connType === "main") {
        continue;
      }
      for (const items of outputs) {
        if (!items) continue;
        for (const item of items) {
          result.push({
            fromNode,
            toNode: item.node,
            connectionType: connType,
          });
        }
      }
    }
  }

  return result;
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

  // Replace $input.first().json / $input.item.json with predecessor variable name in jsCode
  const inputVarName = _codeInputRefMap.get(nodeName);
  if (inputVarName && typeof params.jsCode === "string") {
    params.jsCode = (params.jsCode as string)
      .replace(/\$input\.first\(\)\.json/g, inputVarName)
      .replace(/\$input\.item\.json/g, inputVarName);
  }

  const pad = " ".repeat(indent);
  const paramsStr = serializeObject(params, indent);

  const refVarName = _nodeRefMap.get(nodeName);
  const isReferenced = refVarName !== undefined;

  // Build options (credentials, name) — but use @name JSDoc for space-containing names
  // For referenced nodes with custom names, also suppress name from options and use @name instead
  const hasSpaceInName = nodeHasSpaceName(node);
  const hasCustomName = nodeHasCustomName(node);
  const suppressNameInOptions = hasSpaceInName || (isReferenced && hasCustomName);
  const options = buildNodeOptions(node, suppressNameInOptions);

  // Emit @name JSDoc if the node has a custom name and it's either:
  // - space-containing (existing behavior), or
  // - the node is referenced (so the display name must be preserved via @name)
  if (hasCustomName && (hasSpaceInName || isReferenced)) {
    lines.push(`${pad}/** @name ${node.name} */`);
  }

  // Prefix with `const varName = ` if the node is referenced
  const prefix = isReferenced ? `const ${refVarName} = ` : "";

  if (options) {
    lines.push(`${pad}${prefix}n.${node.dslKind}(${paramsStr}, ${serializeObject(options, indent)});`);
  } else if (Object.keys(params).length === 0 && isOptionalParamsNode(node.dslKind)) {
    lines.push(`${pad}${prefix}n.${node.dslKind}();`);
  } else {
    lines.push(`${pad}${prefix}n.${node.dslKind}(${paramsStr});`);
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

/**
 * Build the node call expression string (without `const varName = ` prefix or trailing `;`).
 * Returns the raw `n.kind(params, options)` string.
 */
function buildNodeCallExpression(
  node: GraphNode,
  indent: number,
): string {
  if (!node.dslKind) {
    return `/* unsupported: ${node.type} */`;
  }

  const params = stripEmptyOptions(normalizeParameters(node.type, node.typeVersion, node.parameters));
  const paramsStr = serializeObject(params, indent);

  // For parallel branches, always include name in options (for display name tracking)
  const options = buildNodeOptions(node);

  if (options) {
    return `n.${node.dslKind}(${paramsStr}, ${serializeObject(options, indent)})`;
  }

  if (Object.keys(params).length === 0 && isOptionalParamsNode(node.dslKind)) {
    return `n.${node.dslKind}()`;
  }

  return `n.${node.dslKind}(${paramsStr})`;
}

/**
 * Check if a branch starting at `target` consists of a single node (no successors within the branch).
 */
function isSingleNodeBranch(
  target: string,
  adj: AdjacencyMap,
  convergence: Set<string>,
): boolean {
  const successors = adj.get(target)?.get(0) ?? [];
  return successors.every((s) => convergence.has(s));
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

  // Collect variable names and check if any branch is referenced
  const branchVarNames: (string | undefined)[] = targets.map((target) => {
    return _nodeRefMap.get(target);
  });
  const hasDestructuring = branchVarNames.some((v) => v !== undefined);

  // Build the destructuring prefix
  const destructureNames = branchVarNames.map((v, i) => {
    if (v) return v;
    // Use unique placeholder names for unreferenced branches
    return i === 0 ? "_" : `_${i}`;
  });
  lines.push(`${pad}const [${destructureNames.join(", ")}] = n.parallel(`);

  // Generate each branch independently from the same base visited set.
  const baseVisited = new Set(visited);
  const allBranchVisited: Set<string>[] = [];

  for (const target of targets) {
    const branchVisited = new Set(baseVisited);
    const node = nodeMap.get(target);

    if (!node || convergence.has(target)) {
      lines.push(`${pad}  () => n.noOp(),`);
      allBranchVisited.push(branchVisited);
      continue;
    }

    branchVisited.add(target);

    if (isSingleNodeBranch(target, adj, convergence)) {
      // Single-node branch → expression body
      const callExpr = buildNodeCallExpression(node, indent + 2);
      lines.push(`${pad}  () => ${callExpr},`);
    } else {
      // Multi-node branch → block body
      const branchLines: string[] = [];
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
      lines.push(`${pad}  () => {`);
      lines.push(...branchLines);
      lines.push(`${pad}  },`);
    }

    allBranchVisited.push(branchVisited);
  }

  // Now merge all branch visited sets into the parent
  for (const branchVisited of allBranchVisited) {
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

  const params = stripEmptyOptions(normalizeParameters(node.type, node.typeVersion, node.parameters ?? {}));
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

  // Include typeVersion if it differs from the compiler's default for this node kind
  if (node.dslKind) {
    const defaultVersion = getCompilerDefaultTypeVersion(node.dslKind);
    if (node.typeVersion !== defaultVersion) {
      options.typeVersion = node.typeVersion;
    }
  }

  return Object.keys(options).length > 0 ? options : null;
}

/** Returns true if the node has a custom name (not auto-generated). */
function nodeHasCustomName(node: GraphNode): boolean {
  if (!node.dslKind) {
    return false;
  }
  const autoNamePattern = new RegExp(`^${node.dslKind}_\\d+$`);
  return !autoNamePattern.test(node.name);
}

/** Returns true if the node has a custom name (not auto-generated) that contains spaces. */
function nodeHasSpaceName(node: GraphNode): boolean {
  if (!nodeHasCustomName(node)) {
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
  return dslKind === "manualTrigger" || dslKind === "noOp" || dslKind === "executeWorkflowTrigger";
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

// ── Non-trigger node reference helpers ────────────────────────────────────────

/**
 * Reserved names that must not be used as generated variable names.
 */
const RESERVED_VARIABLE_NAMES = new Set([
  "n", "workflow", "$", "DateTime", "Duration", "Interval",
  // JS reserved words
  "break", "case", "catch", "continue", "debugger", "default", "delete", "do",
  "else", "finally", "for", "function", "if", "in", "instanceof", "new",
  "return", "switch", "this", "throw", "try", "typeof", "var", "void",
  "while", "with", "class", "const", "enum", "export", "extends", "import",
  "super", "implements", "interface", "let", "package", "private", "protected",
  "public", "static", "yield",
]);

/**
 * Scan all node parameters to find which non-trigger node names are referenced
 * by `$('...')` or `$("...")` patterns in expression strings that will actually
 * be unwrapped into JS code (where the reference gets replaced with a variable).
 *
 * Only strings matching `={{...}}` or `{{...}}` (full-string mustache) patterns
 * are considered, since other strings (e.g. long template text) are emitted as
 * plain string literals where `$('...')` stays as-is and no variable is used.
 */
function scanForNodeReferences(
  nodeMap: Map<string, GraphNode>,
  triggerNames: Set<string>,
): Set<string> {
  // Collect only expression strings that would be unwrapped (and thus have
  // their $('...') references replaced with variable names)
  const allExprStrings: string[] = [];
  for (const node of nodeMap.values()) {
    collectUnwrappableExprStrings(node.parameters, allExprStrings);
  }

  const referenced = new Set<string>();
  for (const [name, node] of nodeMap) {
    if (triggerNames.has(name)) continue; // triggers handled separately
    if (!node.dslKind) continue; // unsupported nodes can't become variables

    const escaped = escapeNodeNameForExprRegex(name);
    const pattern = new RegExp(`\\$\\(\\s*['"]${escaped}['"]\\s*\\)`);

    for (const expr of allExprStrings) {
      if (pattern.test(expr)) {
        referenced.add(name);
        break;
      }
    }
  }

  return referenced;
}

/**
 * Recursively collect all string values from a JSON-like value.
 */
function collectStringsFromValue(value: unknown, strings: string[]): void {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsFromValue(item, strings);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      collectStringsFromValue(v, strings);
    }
  }
}

/**
 * Recursively collect string values that could be unwrapped into JS expressions
 * (and thus have their `$('Node')` references replaced with variable names).
 *
 * Only strings matching these patterns are collected:
 * - `={{...}}` format (n8n expression, processed by `tryUnwrapExpression`)
 * - `{{...}}` format (mustache expression wrapping entire string, processed by `tryUnwrapMustacheExpression`)
 *
 * Strings containing n8n-only globals (`$json`, `$node`, etc.) are excluded
 * since those expressions won't be unwrapped regardless.
 */
function collectUnwrappableExprStrings(value: unknown, strings: string[]): void {
  if (typeof value === "string") {
    // Check ={{...}} format
    if (value.startsWith("={{") && value.endsWith("}}")) {
      const body = value.slice(3, -2).trim();
      if (body && !N8N_EXPRESSION_ONLY_GLOBALS.test(body)) {
        strings.push(value);
      }
      return;
    }
    // Check {{...}} mustache format (entire string)
    if (value.startsWith("{{") && value.endsWith("}}")) {
      const body = value.slice(2, -2).trim();
      if (body && !N8N_EXPRESSION_ONLY_GLOBALS.test(body)) {
        strings.push(value);
      }
      return;
    }
    // Check =...{{ }}... mixed template format
    if (value.startsWith("=") && !value.startsWith("={{") && /\{\{[\s\S]*?\}\}/.test(value)) {
      const re = /\{\{([\s\S]*?)\}\}/g;
      let m;
      while ((m = re.exec(value)) !== null) {
        const body = m[1]!.trim();
        if (body && !N8N_EXPRESSION_ONLY_GLOBALS.test(body)) {
          strings.push(body);
        }
      }
      return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUnwrappableExprStrings(item, strings);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      collectUnwrappableExprStrings(v, strings);
    }
  }
}

/**
 * Build a mapping from referenced non-trigger node display name → variable name.
 */
function buildNodeRefMap(
  referencedNames: Set<string>,
  nodeMap: Map<string, GraphNode>,
  triggerRefMap: Map<string, { paramName: string; triggerIndex: number }>,
): Map<string, string> {
  const map = new Map<string, string>();
  const usedNames = new Set<string>(RESERVED_VARIABLE_NAMES);

  // Reserve trigger param names
  for (const { paramName } of triggerRefMap.values()) {
    usedNames.add(paramName);
  }

  // Reserve shared const names
  for (const constName of _sharedValueData.keys()) {
    usedNames.add(constName);
  }

  // Iterate in nodeMap order (workflow JSON order) for deterministic naming
  for (const [name, node] of nodeMap) {
    if (!referencedNames.has(name)) continue;
    if (!node.dslKind) continue;

    let varName = node.dslKind;
    if (usedNames.has(varName)) {
      let suffix = 2;
      while (usedNames.has(`${varName}${suffix}`)) suffix++;
      varName = `${varName}${suffix}`;
    }
    usedNames.add(varName);

    map.set(name, varName);
  }

  return map;
}

/**
 * Escape a node name for use in a regex pattern that matches `$('Name')` or `$("Name")`.
 * Handles regex special chars AND quote escaping (e.g. `'` may appear as `\'` in expressions).
 */
function escapeNodeNameForExprRegex(name: string): string {
  // First, escape regex special chars
  let escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Then, handle quote escaping: each ' could be escaped as \' in the expression
  escaped = escaped.replace(/'/g, "(?:\\\\'|')");
  escaped = escaped.replace(/"/g, '(?:\\\\"|")');
  return escaped;
}

// ── Code node $input helpers ──────────────────────────────────────────────────

/**
 * Check if a jsCode string contains `$input.first().json` or `$input.item.json` references.
 */
function hasInputReference(jsCode: string): boolean {
  return /\$input\.(?:first\(\)|item)\.json/.test(jsCode);
}

/**
 * Scan code nodes for `$input.first().json` / `$input.item.json` usage.
 * Returns a map from code node display name → single predecessor node display name.
 */
function scanCodeNodeInputPredecessors(
  nodeMap: Map<string, GraphNode>,
  reverseAdj: ReverseAdjacencyMap,
  triggerNames: Set<string>,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const [name, node] of nodeMap) {
    if (node.type !== "n8n-nodes-base.code") continue;

    const jsCode = node.parameters.jsCode;
    if (typeof jsCode !== "string" || !hasInputReference(jsCode)) continue;

    // Find single predecessor
    const predecessors = reverseAdj.get(name);
    if (!predecessors || predecessors.size !== 1) continue;

    const predName = [...predecessors][0]!;
    const predNode = nodeMap.get(predName);
    if (!predNode) continue;

    // Predecessor must be a known node (trigger or action with dslKind)
    if (!triggerNames.has(predName) && !predNode.dslKind) continue;

    result.set(name, predName);
  }

  return result;
}

// ── Node reference replacement helpers ────────────────────────────────────────

/**
 * Replace `$('Node Name').item.json` / `.first().json` / `.json` patterns
 * for non-trigger nodes in an expression body with the corresponding variable name.
 */
function replaceNodeReferences(body: string): { replaced: string; hadReplacement: boolean } {
  let replaced = body;
  let hadReplacement = false;

  for (const [nodeName, varName] of _nodeRefMap) {
    const escaped = escapeNodeNameForExprRegex(nodeName);
    const pattern = new RegExp(
      `\\$\\(\\s*['"]${escaped}['"]\\s*\\)(?:\\.item)?(?:\\.first\\(\\))?\\.json`,
      "g",
    );
    const newBody = replaced.replace(pattern, varName);
    if (newBody !== replaced) {
      replaced = newBody;
      hadReplacement = true;
    }
  }

  return { replaced, hadReplacement };
}

/**
 * Replace `$('Trigger Name').item.json` / `.first().json` / `.json` patterns
 * in an expression body with the corresponding execute parameter name.
 */
function replaceTriggerReferences(body: string): { replaced: string; hadReplacement: boolean } {
  let replaced = body;
  let hadReplacement = false;

  for (const [triggerName, { paramName, triggerIndex }] of _triggerRefMap) {
    const escaped = escapeNodeNameForExprRegex(triggerName);
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
 * Check if a string is a valid JavaScript expression by attempting to parse it.
 */
function isValidJSExpression(body: string): boolean {
  try {
    const wrapped = `const _ = (${body});`;
    const result = oxcParseSync("expr.ts", wrapped, {
      lang: "ts",
      sourceType: "module",
    });
    return result.errors.length === 0;
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
  const { replaced: afterTrigger } = replaceTriggerReferences(body);
  body = afterTrigger;

  // Replace $('Node Name').item.json → varName for non-trigger nodes
  const { replaced: afterNode } = replaceNodeReferences(body);
  body = afterNode;

  // Don't unwrap expressions that use n8n-only globals ($json, $node, etc.)
  if (N8N_EXPRESSION_ONLY_GLOBALS.test(body)) {
    return null;
  }

  // Must be a valid JavaScript expression
  if (!isValidJSExpression(body)) {
    return null;
  }

  // Track which n8n globals are referenced so the import line can include them
  trackN8nGlobals(body);

  return body;
}

/**
 * Try to unwrap a mustache expression string (`{{ expr }}`) into raw JavaScript.
 * These appear inside parsed jsonBody objects (n8n JSON template syntax).
 *
 * Returns the raw JS expression body, or `null` if the value should stay
 * as a quoted string.
 */
function tryUnwrapMustacheExpression(value: string): string | null {
  const match = value.match(/^\{\{([\s\S]+)\}\}$/);
  if (!match) {
    return null;
  }

  let body = match[1]!.trim();
  if (!body) {
    return null;
  }

  // Replace $('Trigger Name').item.json → paramName
  const { replaced: afterTrigger } = replaceTriggerReferences(body);
  body = afterTrigger;

  // Replace $('Node Name').item.json → varName for non-trigger nodes
  const { replaced: afterNode } = replaceNodeReferences(body);
  body = afterNode;

  // Don't unwrap expressions that use n8n-only globals
  if (N8N_EXPRESSION_ONLY_GLOBALS.test(body)) {
    return null;
  }

  // Must be a valid JavaScript expression
  if (!isValidJSExpression(body)) {
    return null;
  }

  trackN8nGlobals(body);

  return body;
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
  // jsCode is serialized as an arrow function body, not a string
  if (key === "jsCode" && typeof value === "string") {
    return `${safeKey(key)}: ${serializeAsArrowFunction(value, indent)}`;
  }
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
    // Try to unwrap n8n expression ={{...}} to raw JS
    const unwrapped = tryUnwrapExpression(value);
    if (unwrapped !== null) {
      return unwrapped;
    }
    // Try to unwrap mustache expression {{...}} (e.g. inside jsonBody values)
    const mustacheUnwrapped = tryUnwrapMustacheExpression(value);
    if (mustacheUnwrapped !== null) {
      return mustacheUnwrapped;
    }
    // Convert n8n mixed template (=text {{ expr }} text) to TS template literal
    if (isMixedTemplate(value) && canConvertMixedTemplate(value)) {
      return serializeMixedTemplate(value);
    }
    // Use template literal for multiline strings (more readable than JSON.stringify with \n)
    if (shouldUseTemplateLiteral(value)) {
      return serializeAsTemplateLiteral(value);
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

// ── Template literal helpers ──────────────────────────────────────────────────

/**
 * Determines whether a string value should be serialized as a template literal
 * instead of a JSON-quoted string. This improves readability for long multiline
 * strings such as jsCode, systemMessage, and prompt text fields.
 *
 * Criteria: the string contains at least one newline character.
 */
function shouldUseTemplateLiteral(value: string): boolean {
  return value.includes("\n");
}

/**
 * Escape a string for safe embedding inside a template literal (backtick string).
 *
 * Escapes:
 * - `\` → `\\`  (backslash must be escaped first)
 * - `` ` `` → `` \` ``  (backtick delimiter)
 * - `${` → `\${`  (prevent template interpolation)
 */
function escapeForTemplateLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/**
 * Serialize a string as a TypeScript template literal (backtick string).
 * The result is a valid TS expression: `` `...` ``
 */
function serializeAsTemplateLiteral(value: string): string {
  return "`" + escapeForTemplateLiteral(value) + "`";
}

// ── Arrow function serialization (jsCode) ─────────────────────────────────────

/**
 * Serialize a jsCode string as an arrow function body.
 *
 * Single-line code (no newlines): `() => { code }`
 * Multi-line code: indented block with proper dedent.
 *
 * For multi-line, `await`-containing code is emitted as `async () => { ... }`.
 */
function serializeAsArrowFunction(code: string, indent: number): string {
  const hasAwait = /\bawait\b/.test(code);
  const prefix = hasAwait ? "async " : "";

  if (!code.includes("\n")) {
    return `${prefix}() => { ${code} }`;
  }

  const trimmed = code.replace(/\n$/, "");
  const lines = trimmed.split("\n");
  const bodyPad = " ".repeat(indent + 2);
  const closePad = " ".repeat(indent);
  const indentedLines = lines.map((l) => (l.length > 0 ? `${bodyPad}${l}` : ""));

  return `${prefix}() => {\n${indentedLines.join("\n")}\n${closePad}}`;
}

// ── n8n mixed template helpers ────────────────────────────────────────────────

/**
 * Detect an n8n "mixed template" string: starts with `=`, is NOT a full-string
 * expression (`={{...}}`), and contains `{{ expr }}` interpolation(s).
 *
 * Examples:
 * - `"=text {{ $('Node').item.json.name }} more"` → true
 * - `"={{$json.ok}}"` → false (full expression, handled elsewhere)
 * - `"=plain text"` → false (no interpolation)
 */
function isMixedTemplate(value: string): boolean {
  if (!value.startsWith("=")) return false;
  if (value.startsWith("={{")) return false;
  return /\{\{[\s\S]*?\}\}/.test(value);
}

/**
 * Check whether a mixed template can be converted to a TS template literal.
 * Returns false if any embedded expression contains n8n-only globals that
 * cannot be represented in raw TS code.
 */
function canConvertMixedTemplate(value: string): boolean {
  const body = value.slice(1);
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const exprBody = m[1]!.trim();
    if (exprBody && N8N_EXPRESSION_ONLY_GLOBALS.test(exprBody)) {
      return false;
    }
  }
  return true;
}

/**
 * Convert an n8n mixed template string (`=text {{ expr }} text`) into a TS
 * template literal with `${expr}` interpolations.
 *
 * - Strips the leading `=`.
 * - Replaces each `{{ expr }}` with `${convertedExpr}`, applying trigger/node
 *   reference replacement and tracking n8n globals.
 * - Escapes literal text segments for safe embedding in backtick strings.
 */
function serializeMixedTemplate(value: string): string {
  const body = value.slice(1); // strip leading '='

  const re = /\{\{([\s\S]*?)\}\}/g;
  let result = "`";
  let lastIndex = 0;
  let m;

  while ((m = re.exec(body)) !== null) {
    // Add literal text before this expression
    if (m.index > lastIndex) {
      result += escapeForTemplateLiteral(body.slice(lastIndex, m.index));
    }

    // Process the expression
    let expr = m[1]!.trim();

    // Apply trigger reference replacement ($('TriggerName').item.json → param)
    const { replaced: afterTrigger } = replaceTriggerReferences(expr);
    expr = afterTrigger;

    // Apply node reference replacement ($('NodeName').item.json → varName)
    const { replaced: afterNode } = replaceNodeReferences(expr);
    expr = afterNode;

    // Track n8n globals (DateTime, $, etc.) for import generation
    trackN8nGlobals(expr);

    result += "${" + expr + "}";
    lastIndex = m.index + m[0].length;
  }

  // Add remaining literal text
  if (lastIndex < body.length) {
    result += escapeForTemplateLiteral(body.slice(lastIndex));
  }

  result += "`";
  return result;
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
