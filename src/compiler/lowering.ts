import type {
  CfgBlock,
  CfgDslNodeCall,
  CfgForOfStatement,
  CfgIfStatement,
  CfgStatement,
} from "./cfg";
import {
  createEdgeIR,
  createNodeIR,
  createWorkflowIRFrame,
  type EdgeIR,
  type WorkflowIR,
} from "./ir";

type LowerControlFlowGraphToIRInput = {
  name: string;
  cfg: CfgBlock;
};

type FrontierPort = {
  nodeKey: string;
  outputIndex: number;
};

type LoweringContext = {
  workflow: WorkflowIR;
  counter: number;
  frontier: FrontierPort[];
};

const NODE_TYPE_BY_KIND = {
  manualTrigger: "n8n-nodes-base.manualTrigger",
  httpRequest: "n8n-nodes-base.httpRequest",
  set: "n8n-nodes-base.set",
  noOp: "n8n-nodes-base.noOp",
  if: "n8n-nodes-base.if",
  splitInBatches: "n8n-nodes-base.splitInBatches",
} as const;

export function lowerControlFlowGraphToIR(input: LowerControlFlowGraphToIRInput): WorkflowIR {
  const context: LoweringContext = {
    workflow: createWorkflowIRFrame({ name: input.name }),
    counter: 0,
    frontier: [],
  };

  lowerStatements(input.cfg.body, context);
  return context.workflow;
}

function lowerStatements(statements: CfgStatement[], context: LoweringContext): void {
  for (const statement of statements) {
    lowerStatement(statement, context);
  }
}

function lowerStatement(statement: CfgStatement, context: LoweringContext): void {
  switch (statement.type) {
    case "Block":
      lowerStatements(statement.body, context);
      return;
    case "NodeCall":
      appendNode(statement.call, context);
      return;
    case "Variable":
      appendNode(statement.call, context, statement.name);
      return;
    case "If":
      lowerIfStatement(statement, context);
      return;
    case "ForOf":
      lowerForOfStatement(statement, context);
      return;
    default:
      return assertNever(statement);
  }
}

function lowerIfStatement(statement: CfgIfStatement, context: LoweringContext): void {
  if (statement.test.type === "BooleanLiteral") {
    const selected = statement.test.value ? statement.consequent : statement.alternate;
    lowerStatements(selected, context);
    return;
  }

  const ifNodeKey = appendIfNode(context);
  const consequentFrontier = lowerBranchWithFrontier(
    statement.consequent,
    [{ nodeKey: ifNodeKey, outputIndex: 0 }],
    context,
  );
  const alternateFrontier = lowerBranchWithFrontier(
    statement.alternate,
    [{ nodeKey: ifNodeKey, outputIndex: 1 }],
    context,
  );

  context.frontier = mergeFrontiers(consequentFrontier, alternateFrontier);
}

function lowerForOfStatement(statement: CfgForOfStatement, context: LoweringContext): void {
  const loopNodeKey = appendLoopNode(context);
  const bodyTerminalFrontier = lowerBranchWithFrontier(
    statement.body,
    [{ nodeKey: loopNodeKey, outputIndex: 1 }],
    context,
  );

  context.workflow.edges.push(...buildLoopBackEdges(bodyTerminalFrontier, loopNodeKey));
  context.frontier = [{ nodeKey: loopNodeKey, outputIndex: 0 }];
}

function appendNode(
  call: CfgDslNodeCall,
  context: LoweringContext,
  variableName?: string,
): void {
  context.counter += 1;
  const node = createNodeIR({
    kind: call.kind,
    n8nType: NODE_TYPE_BY_KIND[call.kind],
    counter: context.counter,
    variableName,
    parameters: call.parameters,
  });

  context.workflow.nodes.push(node);
  context.workflow.edges.push(...buildConnectionsFromFrontier(context.frontier, node.key));
  context.frontier = [{ nodeKey: node.key, outputIndex: 0 }];
}

function appendIfNode(context: LoweringContext): string {
  context.counter += 1;
  const node = createNodeIR({
    kind: "if",
    n8nType: NODE_TYPE_BY_KIND.if,
    counter: context.counter,
    parameters: {},
  });

  context.workflow.nodes.push(node);
  context.workflow.edges.push(...buildConnectionsFromFrontier(context.frontier, node.key));
  return node.key;
}

function appendLoopNode(context: LoweringContext): string {
  context.counter += 1;
  const node = createNodeIR({
    kind: "splitInBatches",
    n8nType: NODE_TYPE_BY_KIND.splitInBatches,
    typeVersion: 3,
    counter: context.counter,
    parameters: {},
  });

  context.workflow.nodes.push(node);
  context.workflow.edges.push(...buildConnectionsFromFrontier(context.frontier, node.key));
  return node.key;
}

function lowerBranchWithFrontier(
  statements: CfgStatement[],
  branchFrontier: FrontierPort[],
  context: LoweringContext,
): FrontierPort[] {
  const savedFrontier = context.frontier;
  context.frontier = branchFrontier;
  lowerStatements(statements, context);
  const merged = context.frontier;
  context.frontier = savedFrontier;
  return merged;
}

function mergeFrontiers(...groups: FrontierPort[][]): FrontierPort[] {
  return groups.flat();
}

function buildConnectionsFromFrontier(frontier: FrontierPort[], toNodeKey: string): EdgeIR[] {
  const edges: EdgeIR[] = [];

  for (const port of frontier) {
    edges.push(
      createEdgeIR({
        from: port.nodeKey,
        fromOutputIndex: port.outputIndex,
        to: toNodeKey,
      }),
    );
  }

  return edges;
}

function buildLoopBackEdges(frontier: FrontierPort[], loopNodeKey: string): EdgeIR[] {
  const edges: EdgeIR[] = [];

  for (const port of frontier) {
    edges.push(
      createEdgeIR({
        from: port.nodeKey,
        fromOutputIndex: port.outputIndex,
        to: loopNodeKey,
        kind: "loop-back",
      }),
    );
  }

  return edges;
}

function assertNever(value: never): never {
  throw new Error(`Unreachable statement variant: ${JSON.stringify(value)}`);
}
