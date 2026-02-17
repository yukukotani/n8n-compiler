import type { ArrayExpression, Comment, Expression, Program } from "oxc-parser";
import { TRIGGER_NODE_KINDS } from "../dsl";
import {
  parseExpressionAsJson,
  parseObjectExpression,
  type JsonObject,
  type JsonValue,
} from "./ast-json";
import { buildN8nConnections, type N8nConnections } from "./connections";
import { buildControlFlowGraph } from "./cfg";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";
import { extractEntry } from "./extract-entry";
import type { NodeIR } from "./ir";
import { computeLayout, type NodePosition } from "./layout";
import { lowerControlFlowGraphToIR, type TriggerInput } from "./lowering";
import { parseSync } from "./parse";
import { transformParameters } from "./transform-params";
import { validateWorkflow } from "./validate";

export type N8nNode = {
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: JsonObject;
  credentials?: Record<string, { id: string; name?: string }>;
};

export type CompiledWorkflow = {
  name: string;
  settings: JsonObject;
  nodes: N8nNode[];
  connections: N8nConnections;
};

export type CompileInput = {
  file: string;
  sourceText: string;
};

export type CompileResult = {
  workflow: CompiledWorkflow | null;
  diagnostics: Diagnostic[];
};

type StageResult<T> = {
  value: T | null;
  diagnostics: Diagnostic[];
};

export function compile(input: CompileInput): CompileResult {
  const diagnostics: Diagnostic[] = [];

  let comments: Comment[] = [];
  const program = runStage(diagnostics, () => {
    const parseResult = parseSync(input.file, input.sourceText);
    comments = parseResult.comments;
    return {
      value: parseResult.program,
      diagnostics: parseResult.diagnostics,
    };
  });
  if (!program) {
    return { workflow: null, diagnostics };
  }

  const bindings = collectTopLevelBindings(program);

  const entry = runStage(diagnostics, () => {
    const extractResult = extractEntry(input.file, program);
    return {
      value: extractResult.entry,
      diagnostics: extractResult.diagnostics,
    };
  });
  if (!entry) {
    return { workflow: null, diagnostics };
  }

  const metadata = runStage(diagnostics, () => buildWorkflowMetadata(input.file, entry.name, entry.settings));
  if (!metadata) {
    return { workflow: null, diagnostics };
  }

  const triggers = runStage(diagnostics, () => parseTriggers(input.file, entry.triggers, bindings));
  if (!triggers) {
    return { workflow: null, diagnostics };
  }

  const triggerVarNames = extractExecuteParamNames(entry.execute);
  if (triggerVarNames.length > triggers.length) {
    diagnostics.push(
      createErrorDiagnostic({
        code: "E_INVALID_WORKFLOW_SCHEMA",
        message: `execute function has ${triggerVarNames.length} parameter(s) but only ${triggers.length} trigger(s) defined`,
        file: input.file,
        start: entry.execute.start,
        end: entry.execute.end,
      }),
    );
    return { workflow: null, diagnostics };
  }

  const cfg = runStage(diagnostics, () => {
    const cfgResult = buildControlFlowGraph(input.file, entry.execute, triggerVarNames, {
      sourceText: input.sourceText,
      comments,
      bindings,
    });
    return {
      value: cfgResult.cfg,
      diagnostics: cfgResult.diagnostics,
    };
  });
  if (!cfg) {
    return { workflow: null, diagnostics };
  }

  const triggersWithVarNames = triggers.map((trigger, i) => ({
    ...trigger,
    ...(triggerVarNames[i] != null && { variableName: triggerVarNames[i] }),
  }));

  const workflowIR = lowerControlFlowGraphToIR({
    name: metadata.name,
    triggers: triggersWithVarNames,
    cfg,
  });
  workflowIR.settings = metadata.settings;

  const validateResult = validateWorkflow(input.file, workflowIR);
  diagnostics.push(...validateResult.diagnostics);
  if (validateResult.diagnostics.length > 0) {
    return { workflow: null, diagnostics };
  }

  const positions = computeLayout(workflowIR.nodes, workflowIR.edges);
  const positionMap = new Map(positions.map((p) => [p.nodeKey, p]));
  const nameMap = new Map(workflowIR.nodes.map((n) => [n.key, n.displayName ?? n.key]));

  const remappedEdges = workflowIR.edges.map((edge) => ({
    ...edge,
    from: nameMap.get(edge.from) ?? edge.from,
    to: nameMap.get(edge.to) ?? edge.to,
  }));

  return {
    workflow: {
      name: workflowIR.name,
      settings: workflowIR.settings as JsonObject,
      nodes: workflowIR.nodes.map((node) => toN8nNode(node, positionMap)),
      connections: buildN8nConnections(remappedEdges),
    },
    diagnostics,
  };
}

function runStage<T>(
  diagnostics: Diagnostic[],
  stage: () => StageResult<T>,
): T | null {
  const result = stage();
  diagnostics.push(...result.diagnostics);

  if (result.diagnostics.length > 0 || !result.value) {
    return null;
  }

  return result.value;
}

function buildWorkflowMetadata(
  file: string,
  nameExpression: Expression,
  settingsExpression: Expression | null,
): StageResult<{ name: string; settings: JsonObject }> {
  const diagnostics: Diagnostic[] = [];
  const name = parseWorkflowName(nameExpression);
  if (!name) {
    diagnostics.push(
      createErrorDiagnostic({
        code: "E_INVALID_WORKFLOW_SCHEMA",
        message: "workflow.name must be a string literal",
        file,
        start: nameExpression.start,
        end: nameExpression.end,
      }),
    );
  }

  const settings = parseWorkflowSettings(settingsExpression);
  if (!settings) {
    diagnostics.push(
      createErrorDiagnostic({
        code: "E_INVALID_WORKFLOW_SCHEMA",
        message: "workflow.settings must be a JSON object literal",
        file,
        start: settingsExpression?.start,
        end: settingsExpression?.end,
      }),
    );
  }

  if (!name || !settings) {
    return {
      value: null,
      diagnostics,
    };
  }

  return {
    value: {
      name,
      settings,
    },
    diagnostics,
  };
}

function toN8nNode(node: NodeIR, positionMap: Map<string, NodePosition>): N8nNode {
  const layoutPosition = positionMap.get(node.key);
  const position: [number, number] = layoutPosition
    ? [layoutPosition.x, layoutPosition.y]
    : (node.position ?? [0, 0]);

  const n8nNode: N8nNode = {
    name: node.displayName ?? node.key,
    type: node.n8nType,
    typeVersion: node.typeVersion,
    position,
    parameters: transformParameters(node.n8nType, node.typeVersion, node.parameters as JsonObject),
  };

  if (node.credentials) {
    n8nNode.credentials = node.credentials;
  }

  return n8nNode;
}

type ExecuteParam = { type: string; name?: string };

function extractExecuteParamNames(execute: Expression): string[] {
  if (execute.type !== "FunctionExpression" && execute.type !== "ArrowFunctionExpression") {
    return [];
  }

  const params = (execute as unknown as { params: ExecuteParam[] }).params;
  const names: string[] = [];

  for (const param of params) {
    if (param.type === "Identifier" && param.name) {
      names.push(param.name);
    }
  }

  return names;
}

function parseWorkflowName(expression: Expression): string | null {
  if (expression.type !== "Literal") {
    return null;
  }

  if (typeof expression.value !== "string") {
    return null;
  }

  return expression.value;
}

function parseWorkflowSettings(expression: Expression | null): JsonObject | null {
  if (!expression) {
    return {};
  }

  if (expression.type !== "ObjectExpression") {
    return null;
  }

  return parseObjectExpression(expression);
}

function parseTriggers(
  file: string,
  triggersExpression: Expression,
  bindings?: ReadonlyMap<string, JsonValue>,
): StageResult<TriggerInput[]> {
  if (triggersExpression.type !== "ArrayExpression") {
    return {
      value: null,
      diagnostics: [
        createErrorDiagnostic({
          code: "E_INVALID_TRIGGER",
          message: "triggers must be an array literal",
          file,
          start: triggersExpression.start,
          end: triggersExpression.end,
        }),
      ],
    };
  }

  const arrayExpression = triggersExpression as ArrayExpression;
  const diagnostics: Diagnostic[] = [];
  const triggers: TriggerInput[] = [];

  if (arrayExpression.elements.length === 0) {
    diagnostics.push(
      createErrorDiagnostic({
        code: "E_INVALID_TRIGGER",
        message: "triggers array must contain at least one trigger",
        file,
        start: arrayExpression.start,
        end: arrayExpression.end,
      }),
    );
    return { value: null, diagnostics };
  }

  for (const element of arrayExpression.elements) {
    if (!element || element.type === "SpreadElement") {
      diagnostics.push(
        createErrorDiagnostic({
          code: "E_INVALID_TRIGGER",
          message: "trigger element must be a n.<trigger>(...) call",
          file,
          start: element?.start ?? arrayExpression.start,
          end: element?.end ?? arrayExpression.end,
        }),
      );
      continue;
    }

    if (element.type !== "CallExpression") {
      diagnostics.push(
        createErrorDiagnostic({
          code: "E_INVALID_TRIGGER",
          message: "trigger element must be a n.<trigger>(...) call",
          file,
          start: element.start,
          end: element.end,
        }),
      );
      continue;
    }

    const callee = element.callee;
    if (
      callee.type !== "MemberExpression" ||
      callee.computed ||
      callee.object.type !== "Identifier" ||
      callee.object.name !== "n" ||
      callee.property.type !== "Identifier"
    ) {
      diagnostics.push(
        createErrorDiagnostic({
          code: "E_INVALID_TRIGGER",
          message: "trigger element must be a n.<trigger>(...) call",
          file,
          start: element.start,
          end: element.end,
        }),
      );
      continue;
    }

    const triggerName = callee.property.name;
    if (!TRIGGER_NODE_KINDS.has(triggerName)) {
      diagnostics.push(
        createErrorDiagnostic({
          code: "E_INVALID_TRIGGER",
          message: `Unknown trigger: n.${triggerName}(...). Supported triggers: ${[...TRIGGER_NODE_KINDS].join(", ")}`,
          file,
          start: element.start,
          end: element.end,
        }),
      );
      continue;
    }

    const firstArg = element.arguments[0];
    let parameters: JsonObject = {};
    if (firstArg && firstArg.type !== "SpreadElement" && firstArg.type === "ObjectExpression") {
      const parsed = parseExpressionAsJson(firstArg, new Set(), undefined, bindings);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        parameters = parsed as JsonObject;
      }
    }

    const secondArg = element.arguments[1];
    let credentials: Record<string, { id: string; name?: string }> | undefined;
    let triggerDisplayName: string | undefined;
    let triggerPosition: [number, number] | undefined;
    if (secondArg && secondArg.type !== "SpreadElement" && secondArg.type === "ObjectExpression") {
      const parsed = parseExpressionAsJson(secondArg, new Set(), undefined, bindings);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const opts = parsed as Record<string, unknown>;
        if (opts.credentials && typeof opts.credentials === "object" && !Array.isArray(opts.credentials)) {
          credentials = opts.credentials as Record<string, { id: string; name?: string }>;
        }
        if (typeof opts.name === "string") {
          triggerDisplayName = opts.name;
        }
        if (
          Array.isArray(opts.position) &&
          opts.position.length === 2 &&
          typeof opts.position[0] === "number" &&
          typeof opts.position[1] === "number"
        ) {
          triggerPosition = opts.position as [number, number];
        }
      }
    }

    triggers.push({
      kind: triggerName,
      parameters,
      ...(credentials && { credentials }),
      ...(triggerDisplayName && { name: triggerDisplayName }),
      ...(triggerPosition && { position: triggerPosition }),
    });
  }

  if (diagnostics.length > 0) {
    return { value: null, diagnostics };
  }

  return { value: triggers, diagnostics: [] };
}

/**
 * Collect top-level `const` declarations with literal initializers
 * so that shorthand references like `{ googleCalendarOAuth2Api }` can be resolved.
 */
function collectTopLevelBindings(program: Program): Map<string, JsonValue> {
  const bindings = new Map<string, JsonValue>();

  for (const statement of program.body) {
    if (
      statement.type !== "VariableDeclaration" ||
      statement.kind !== "const"
    ) {
      continue;
    }

    for (const declarator of (statement as { declarations: Array<{ id: Expression; init: Expression | null }> }).declarations) {
      if (declarator.id.type !== "Identifier" || !declarator.init) {
        continue;
      }

      // Parse the initializer as a plain JSON value (no variable references)
      const value = parseExpressionAsJson(declarator.init);
      if (value !== null) {
        bindings.set((declarator.id as { name: string }).name, value);
      }
    }
  }

  return bindings;
}
