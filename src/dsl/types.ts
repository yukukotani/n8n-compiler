export type JsonObject = Record<string, unknown>;

export type WorkflowSettings = JsonObject;

export type WorkflowExecute = () => void | Promise<void>;

export type WorkflowDefinition = {
  name: string;
  settings?: WorkflowSettings;
  execute: WorkflowExecute;
};

export type NodeParams = JsonObject;

export type NodeKind = "manualTrigger" | "httpRequest" | "set" | "noOp";

export type NodeRef<
  Kind extends NodeKind = NodeKind,
  Params extends NodeParams = NodeParams,
> = {
  readonly __brand: "NodeRef";
  readonly kind: Kind;
  readonly params: Params;
};

export type ExpressionValue = `={{${string}}}`;

export type ConditionRef<Value extends ExpressionValue = ExpressionValue> = {
  readonly __brand: "ConditionRef";
  readonly expression: Value;
};

export type LoopOptions = {
  batchSize?: number;
  reset?: boolean;
};

export type LoopToken = {
  readonly __brand: "LoopToken";
};

export type LoopIterable = Iterable<LoopToken>;
