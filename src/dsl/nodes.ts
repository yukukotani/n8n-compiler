import type {
  ConditionRef,
  ExpressionValue,
  LoopIterable,
  LoopOptions,
  LoopToken,
  NodeKind,
  NodeParams,
  NodeRef,
} from "./types";

const LOOP_SOURCE: LoopToken[] = [];

function createNodeRef<Kind extends NodeKind, Params extends NodeParams>(
  kind: Kind,
  params: Params,
): NodeRef<Kind, Params> {
  return {
    __brand: "NodeRef",
    kind,
    params,
  };
}

export const n = {
  manualTrigger(params: NodeParams = {}): NodeRef<"manualTrigger"> {
    return createNodeRef("manualTrigger", params);
  },

  httpRequest(params: NodeParams): NodeRef<"httpRequest"> {
    return createNodeRef("httpRequest", params);
  },

  set(params: NodeParams): NodeRef<"set"> {
    return createNodeRef("set", params);
  },

  noOp(params: NodeParams = {}): NodeRef<"noOp"> {
    return createNodeRef("noOp", params);
  },

  expr<Value extends ExpressionValue>(value: Value): ConditionRef<Value> {
    return {
      __brand: "ConditionRef",
      expression: value,
    };
  },

  loop(_options: LoopOptions = {}): LoopIterable {
    return LOOP_SOURCE;
  },
};
