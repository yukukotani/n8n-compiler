import type {
  CfgBlock,
  CfgDslNodeCall,
  CfgForOfStatement,
  CfgIfStatement,
  CfgIfTest,
  CfgSwitchStatement,
  CfgStatement,
} from "./cfg";
import {
  createEdgeIR,
  createNodeIR,
  createWorkflowIRFrame,
  type EdgeIR,
  type WorkflowIR,
} from "./ir";

export type TriggerInput = {
  kind: string;
  parameters: Record<string, unknown>;
};

type LowerControlFlowGraphToIRInput = {
  name: string;
  triggers: TriggerInput[];
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
  scheduleTrigger: "n8n-nodes-base.scheduleTrigger",
  webhookTrigger: "n8n-nodes-base.webhook",
  httpRequest: "n8n-nodes-base.httpRequest",
  aggregate: "n8n-nodes-base.aggregate",
  filter: "n8n-nodes-base.filter",
  limit: "n8n-nodes-base.limit",
  merge: "n8n-nodes-base.merge",
  removeDuplicates: "n8n-nodes-base.removeduplicates",
  respondToWebhook: "n8n-nodes-base.respondToWebhook",
  sort: "n8n-nodes-base.sort",
  splitOut: "n8n-nodes-base.splitout",
  switch: "n8n-nodes-base.switch",
  summarize: "n8n-nodes-base.summarize",
  set: "n8n-nodes-base.set",
  wait: "n8n-nodes-base.wait",
  noOp: "n8n-nodes-base.noOp",
  if: "n8n-nodes-base.if",
  splitInBatches: "n8n-nodes-base.splitInBatches",
} as const;

const DEFAULT_TYPE_VERSION: Partial<Record<string, number>> = {
  scheduleTrigger: 1.2,
};

export function lowerControlFlowGraphToIR(input: LowerControlFlowGraphToIRInput): WorkflowIR {
  const context: LoweringContext = {
    workflow: createWorkflowIRFrame({ name: input.name }),
    counter: 0,
    frontier: [],
  };

  appendTriggers(input.triggers, context);
  lowerStatements(input.cfg.body, context);
  return context.workflow;
}

function appendTriggers(triggers: TriggerInput[], context: LoweringContext): void {
  for (const trigger of triggers) {
    const n8nType = NODE_TYPE_BY_KIND[trigger.kind as keyof typeof NODE_TYPE_BY_KIND];
    if (!n8nType) {
      continue;
    }

    context.counter += 1;
    const node = createNodeIR({
      kind: trigger.kind,
      n8nType,
      typeVersion: DEFAULT_TYPE_VERSION[trigger.kind],
      counter: context.counter,
      parameters: trigger.parameters,
    });

    context.workflow.nodes.push(node);
    context.frontier.push({ nodeKey: node.key, outputIndex: 0 });
  }
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
    case "Switch":
      lowerSwitchStatement(statement, context);
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

  const ifNodeKey = appendIfNode(statement.test, context);
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

function lowerSwitchStatement(statement: CfgSwitchStatement, context: LoweringContext): void {
  const switchNodeKey = appendSwitchNode(statement, context);
  const caseFrontiers = statement.cases.map((caseClause, index) => {
    return lowerBranchWithFrontier(
      caseClause.consequent,
      [{ nodeKey: switchNodeKey, outputIndex: index }],
      context,
    );
  });
  const unmatchedOutputIndex = statement.cases.length;
  const defaultFrontier = statement.defaultCase
    ? lowerBranchWithFrontier(
        statement.defaultCase,
        [{ nodeKey: switchNodeKey, outputIndex: unmatchedOutputIndex }],
        context,
      )
    : [{ nodeKey: switchNodeKey, outputIndex: unmatchedOutputIndex }];

  context.frontier = mergeFrontiers(...caseFrontiers, defaultFrontier);
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

function appendIfNode(test: CfgIfTest, context: LoweringContext): string {
  context.counter += 1;
  const node = createNodeIR({
    kind: "if",
    n8nType: NODE_TYPE_BY_KIND.if,
    typeVersion: 2,
    counter: context.counter,
    parameters: buildIfParameters(test),
  });

  context.workflow.nodes.push(node);
  context.workflow.edges.push(...buildConnectionsFromFrontier(context.frontier, node.key));
  return node.key;
}

function buildIfParameters(test: CfgIfTest): Record<string, unknown> {
  if (test.type === "ExprCall") {
    return { expression: test.expression };
  }
  return {};
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

function appendSwitchNode(statement: CfgSwitchStatement, context: LoweringContext): string {
  context.counter += 1;
  const node = createNodeIR({
    kind: "switch",
    n8nType: NODE_TYPE_BY_KIND.switch,
    typeVersion: 3,
    counter: context.counter,
    parameters: {
      expression: statement.discriminant,
      cases: statement.cases.map((caseClause) => ({ value: caseClause.test })),
    },
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
