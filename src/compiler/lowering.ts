import type { CfgBlock, CfgDslNodeCall, CfgStatement } from "./cfg";
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
    case "ForOf":
      return;
    default:
      return assertNever(statement);
  }
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
    parameters: {},
  });

  context.workflow.nodes.push(node);
  context.workflow.edges.push(...buildConnectionsFromFrontier(context.frontier, node.key));
  context.frontier = [{ nodeKey: node.key, outputIndex: 0 }];
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

function assertNever(value: never): never {
  throw new Error(`Unreachable statement variant: ${JSON.stringify(value)}`);
}
