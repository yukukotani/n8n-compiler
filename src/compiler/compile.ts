import type { Expression } from "oxc-parser";
import {
  parseObjectExpression,
  type JsonObject,
} from "./ast-json";
import { buildN8nConnections, type N8nConnections } from "./connections";
import { buildControlFlowGraph } from "./cfg";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";
import { extractEntry } from "./extract-entry";
import type { NodeIR } from "./ir";
import { lowerControlFlowGraphToIR } from "./lowering";
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

  const program = runStage(diagnostics, () => {
    const parseResult = parseSync(input.file, input.sourceText);
    return {
      value: parseResult.program,
      diagnostics: parseResult.diagnostics,
    };
  });
  if (!program) {
    return { workflow: null, diagnostics };
  }

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

  const cfg = runStage(diagnostics, () => {
    const cfgResult = buildControlFlowGraph(input.file, entry.execute);
    return {
      value: cfgResult.cfg,
      diagnostics: cfgResult.diagnostics,
    };
  });
  if (!cfg) {
    return { workflow: null, diagnostics };
  }

  const workflowIR = lowerControlFlowGraphToIR({
    name: metadata.name,
    cfg,
  });
  workflowIR.settings = metadata.settings;

  const validateResult = validateWorkflow(input.file, workflowIR);
  diagnostics.push(...validateResult.diagnostics);
  if (validateResult.diagnostics.length > 0) {
    return { workflow: null, diagnostics };
  }

  return {
    workflow: {
      name: workflowIR.name,
      settings: workflowIR.settings as JsonObject,
      nodes: workflowIR.nodes.map(toN8nNode),
      connections: buildN8nConnections(workflowIR.edges),
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

const DEFAULT_POSITION_X_SPACING = 260;

function toN8nNode(node: NodeIR, index: number): N8nNode {
  const n8nNode: N8nNode = {
    name: node.key,
    type: node.n8nType,
    typeVersion: node.typeVersion,
    position: node.position ?? [DEFAULT_POSITION_X_SPACING * index, 0],
    parameters: transformParameters(node.n8nType, node.typeVersion, node.parameters as JsonObject),
  };

  if (node.credentials) {
    n8nNode.credentials = node.credentials;
  }

  return n8nNode;
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


