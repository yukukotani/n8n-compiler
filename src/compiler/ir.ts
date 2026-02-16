import { createDeterministicId, createNodeKey } from "./ir-identifiers";

type JsonObject = Record<string, unknown>;

export type WorkflowIR = {
  name: string;
  settings: JsonObject;
  nodes: NodeIR[];
  edges: EdgeIR[];
};

export type NodeIR = {
  key: string;
  displayName?: string;
  n8nType: string;
  typeVersion: number;
  parameters: JsonObject;
  credentials?: Record<string, { id: string; name?: string }>;
  position?: [number, number];
};

export type EdgeIR = {
  from: string;
  fromOutputIndex: number;
  to: string;
  toInputIndex: number;
  kind?: "loop-back";
};

type CreateWorkflowIRFrameInput = {
  name: string;
  settings?: JsonObject;
};

type CreateNodeIRInput = {
  kind: string;
  n8nType: string;
  typeVersion?: number;
  counter: number;
  parameters?: JsonObject;
  credentials?: Record<string, { id: string; name?: string }>;
  position?: [number, number];
  variableName?: string;
  displayName?: string;
};

type CreateEdgeIRInput = {
  from: string;
  to: string;
  fromOutputIndex?: number;
  toInputIndex?: number;
  kind?: "loop-back";
};

export function createWorkflowIRFrame(input: CreateWorkflowIRFrameInput): WorkflowIR {
  return {
    name: input.name,
    settings: input.settings ?? {},
    nodes: [],
    edges: [],
  };
}

export function createNodeIR(input: CreateNodeIRInput): NodeIR {
  const key = createNodeKey({
    kind: input.kind,
    counter: input.counter,
    variableName: input.variableName,
  });
  const parameters = input.parameters ?? {};

  return {
    key,
    displayName: input.displayName,
    n8nType: input.n8nType,
    typeVersion: input.typeVersion ?? 1,
    parameters,
    credentials: input.credentials,
    position: input.position,
  };
}

export function createEdgeIR(input: CreateEdgeIRInput): EdgeIR {
  const fromOutputIndex = input.fromOutputIndex ?? 0;
  const toInputIndex = input.toInputIndex ?? 0;

  return {
    from: input.from,
    fromOutputIndex,
    to: input.to,
    toInputIndex,
    kind: input.kind,
  };
}

export { createDeterministicId, createNodeKey };
