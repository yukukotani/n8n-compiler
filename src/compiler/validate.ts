import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";
import type { EdgeIR, NodeIR, WorkflowIR } from "./ir";

type ValidateWorkflowResult = {
  diagnostics: Diagnostic[];
};

type ValidationContext = {
  file: string;
  diagnostics: Diagnostic[];
};

type WorkflowShape = {
  name: unknown;
  settings: unknown;
  nodes: unknown;
  edges: unknown;
};

const TRIGGER_NODE_TYPES = new Set<string>([
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.googleCalendarTrigger",
]);

export function validateWorkflow(file: string, workflow: WorkflowIR): ValidateWorkflowResult {
  const context: ValidationContext = {
    file,
    diagnostics: [],
  };
  const shape = workflow as unknown as WorkflowShape;

  const validatedShape = validateStructuralPhase(shape, context);
  if (!validatedShape) {
    return { diagnostics: context.diagnostics };
  }

  validateReferencePhase(validatedShape.edges, validatedShape.nodes, context);
  validateControlFlowPhase(validatedShape.edges, validatedShape.nodes, context);

  return { diagnostics: context.diagnostics };
}

function validateStructuralPhase(
  workflow: WorkflowShape,
  context: ValidationContext,
): { nodes: NodeIR[]; edges: EdgeIR[] } | null {
  const hasShapeErrors = validateRequiredFields(workflow, context);
  if (hasShapeErrors) {
    return null;
  }

  const nodes = workflow.nodes as NodeIR[];
  const edges = workflow.edges as EdgeIR[];

  validateNodeUniqueness(nodes, context);
  validateTriggerPresence(nodes, context);

  return { nodes, edges };
}

function validateRequiredFields(workflow: WorkflowShape, context: ValidationContext): boolean {
  let invalid = false;

  if (typeof workflow.name !== "string" || workflow.name.length === 0) {
    pushSchemaDiagnostic(context, "workflow.name is required and must be a non-empty string");
    invalid = true;
  }

  if (!isRecord(workflow.settings)) {
    pushSchemaDiagnostic(context, "workflow.settings is required and must be an object");
    invalid = true;
  }

  if (!Array.isArray(workflow.nodes)) {
    pushSchemaDiagnostic(context, "workflow.nodes is required and must be an array");
    invalid = true;
  }

  if (!Array.isArray(workflow.edges)) {
    pushSchemaDiagnostic(context, "workflow.edges is required and must be an array");
    invalid = true;
  }

  return invalid;
}

function validateNodeUniqueness(nodes: NodeIR[], context: ValidationContext): void {
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!node?.key || !node.n8nType) {
      pushSchemaDiagnostic(context, "each node must include key and n8nType");
      continue;
    }

    if (seen.has(node.key)) {
      pushSchemaDiagnostic(context, `node key must be unique: ${node.key}`);
      continue;
    }

    seen.add(node.key);
  }
}

function validateTriggerPresence(nodes: NodeIR[], context: ValidationContext): void {
  const hasTrigger = nodes.some((node) => TRIGGER_NODE_TYPES.has(node.n8nType));
  if (!hasTrigger) {
    pushSchemaDiagnostic(context, "workflow must include at least one trigger node");
  }
}

function validateReferencePhase(edges: EdgeIR[], nodes: NodeIR[], context: ValidationContext): void {
  const nodeKeys = new Set(nodes.map((node) => node.key));

  for (const edge of edges) {
    if (!nodeKeys.has(edge.from)) {
      pushConnectionDiagnostic(context, `edge.from references unknown node: ${edge.from}`);
    }

    if (!nodeKeys.has(edge.to)) {
      pushConnectionDiagnostic(context, `edge.to references unknown node: ${edge.to}`);
    }

    if (!Number.isInteger(edge.fromOutputIndex) || edge.fromOutputIndex < 0) {
      pushConnectionDiagnostic(
        context,
        `edge.fromOutputIndex must be a non-negative integer: ${edge.fromOutputIndex}`,
      );
    }

    if (!Number.isInteger(edge.toInputIndex) || edge.toInputIndex < 0) {
      pushConnectionDiagnostic(
        context,
        `edge.toInputIndex must be a non-negative integer: ${edge.toInputIndex}`,
      );
    }
  }
}

function validateControlFlowPhase(edges: EdgeIR[], nodes: NodeIR[], context: ValidationContext): void {
  validateIfWiring(nodes, edges, context);
  validateSwitchWiring(nodes, edges, context);
  validateLoopWiring(nodes, edges, context);
}

function validateIfWiring(nodes: NodeIR[], edges: EdgeIR[], context: ValidationContext): void {
  const ifNodes = nodes.filter((node) => node.n8nType === "n8n-nodes-base.if");

  for (const node of ifNodes) {
    const outgoing = edges.filter((edge) => edge.from === node.key && edge.kind !== "loop-back");
    const outputIndexes = new Set(outgoing.map((edge) => edge.fromOutputIndex));

    for (const index of outputIndexes) {
      if (index !== 0 && index !== 1) {
        pushConnectionDiagnostic(
          context,
          `if node ${node.key} must only use output indexes 0 and 1, found ${index}`,
        );
      }
    }

    // Note: if nodes are allowed to have only one output wired (e.g. if-without-else)
  }
}

function validateLoopWiring(nodes: NodeIR[], edges: EdgeIR[], context: ValidationContext): void {
  const loopNodes = nodes.filter((node) => node.n8nType === "n8n-nodes-base.splitInBatches");

  for (const node of loopNodes) {
    const outgoing = edges.filter((edge) => edge.from === node.key && edge.kind !== "loop-back");
    const outputIndexes = new Set(outgoing.map((edge) => edge.fromOutputIndex));

    for (const index of outputIndexes) {
      if (index !== 0 && index !== 1) {
        pushConnectionDiagnostic(
          context,
          `splitInBatches node ${node.key} must only use output indexes 0(done) and 1(loop), found ${index}`,
        );
      }
    }

    if (!outputIndexes.has(1)) {
      pushConnectionDiagnostic(
        context,
        `splitInBatches node ${node.key} must wire loop output index 1 to loop body`,
      );
    }

    const loopBackEdges = edges.filter(
      (edge) => edge.kind === "loop-back" && edge.to === node.key && edge.toInputIndex === 0,
    );
    if (loopBackEdges.length === 0) {
      pushConnectionDiagnostic(
        context,
        `splitInBatches node ${node.key} must have at least one loop-back edge to input 0`,
      );
    }
  }
}

function validateSwitchWiring(nodes: NodeIR[], edges: EdgeIR[], context: ValidationContext): void {
  const switchNodes = nodes.filter((node) => node.n8nType === "n8n-nodes-base.switch");

  for (const node of switchNodes) {
    const caseCount = readSwitchCaseCount(node.parameters);
    if (caseCount === null) {
      continue;
    }

    const maxOutputIndex = caseCount;
    const outgoing = edges.filter((edge) => edge.from === node.key && edge.kind !== "loop-back");
    const outputIndexes = new Set(outgoing.map((edge) => edge.fromOutputIndex));

    for (const index of outputIndexes) {
      if (index < 0 || index > maxOutputIndex) {
        pushConnectionDiagnostic(
          context,
          `switch node ${node.key} must only use output indexes 0..${maxOutputIndex}, found ${index}`,
        );
      }
    }
  }
}

function readSwitchCaseCount(parameters: unknown): number | null {
  if (!isRecord(parameters)) {
    return null;
  }

  if (!("cases" in parameters) || !Array.isArray(parameters.cases)) {
    return null;
  }

  return parameters.cases.length;
}

function pushSchemaDiagnostic(context: ValidationContext, message: string): void {
  context.diagnostics.push(
    createErrorDiagnostic({
      code: "E_INVALID_WORKFLOW_SCHEMA",
      message,
      file: context.file,
    }),
  );
}

function pushConnectionDiagnostic(context: ValidationContext, message: string): void {
  context.diagnostics.push(
    createErrorDiagnostic({
      code: "E_INVALID_CONNECTION",
      message,
      file: context.file,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
