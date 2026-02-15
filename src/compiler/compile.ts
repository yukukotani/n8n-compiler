import type { ArrayExpression, Expression, ObjectExpression } from "oxc-parser";
import { buildN8nConnections, type N8nConnections } from "./connections";
import { buildControlFlowGraph } from "./cfg";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";
import { extractEntry } from "./extract-entry";
import type { NodeIR } from "./ir";
import { lowerControlFlowGraphToIR } from "./lowering";
import { parseSync } from "./parse";
import { validateWorkflow } from "./validate";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type CompiledWorkflow = {
  name: string;
  settings: JsonObject;
  nodes: NodeIR[];
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
      nodes: workflowIR.nodes,
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

function parseExpressionAsJson(expression: Expression): JsonValue | null {
  if (expression.type === "Literal") {
    const value = expression.value;
    if (value === null) {
      return null;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    return null;
  }

  if (expression.type === "ObjectExpression") {
    return parseObjectExpression(expression);
  }

  if (expression.type === "ArrayExpression") {
    return parseArrayExpression(expression);
  }

  return null;
}

function parseObjectExpression(expression: ObjectExpression): JsonObject | null {
  const result: JsonObject = {};

  for (const property of expression.properties) {
    if (property.type !== "Property" || property.kind !== "init" || property.method) {
      return null;
    }

    const key = parsePropertyKey(property.key);
    if (!key) {
      return null;
    }

    const value = parseExpressionAsJson(property.value);
    if (value === null && !isNullLiteral(property.value)) {
      return null;
    }

    result[key] = value;
  }

  return result;
}

function parseArrayExpression(expression: ArrayExpression): JsonValue[] | null {
  const result: JsonValue[] = [];

  for (const element of expression.elements) {
    if (!element || element.type === "SpreadElement") {
      return null;
    }

    const value = parseExpressionAsJson(element);
    if (value === null && !isNullLiteral(element)) {
      return null;
    }

    result.push(value);
  }

  return result;
}

function parsePropertyKey(key: unknown): string | null {
  if (!key || typeof key !== "object" || !("type" in key)) {
    return null;
  }

  if (key.type === "Identifier" && "name" in key && typeof key.name === "string") {
    return key.name;
  }

  if (key.type === "Literal" && "value" in key && typeof key.value === "string") {
    return key.value;
  }

  return null;
}

function isNullLiteral(expression: Expression): boolean {
  return expression.type === "Literal" && expression.value === null;
}
