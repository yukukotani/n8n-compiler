import type {
  ConditionRef,
  ExpressionValue,
  LoopIterable,
  LoopOptions,
  LoopToken,
  NodeKind,
  NodeParams,
  NodeRef,
  ScheduleTriggerParams,
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

  scheduleTrigger(params: ScheduleTriggerParams): NodeRef<"scheduleTrigger", ScheduleTriggerParams> {
    return createNodeRef("scheduleTrigger", params);
  },

  webhookTrigger(params: NodeParams = {}): NodeRef<"webhookTrigger"> {
    return createNodeRef("webhookTrigger", params);
  },

  httpRequest(params: NodeParams): NodeRef<"httpRequest"> {
    return createNodeRef("httpRequest", params);
  },

  merge(params: NodeParams): NodeRef<"merge"> {
    return createNodeRef("merge", params);
  },

  respondToWebhook(params: NodeParams): NodeRef<"respondToWebhook"> {
    return createNodeRef("respondToWebhook", params);
  },

  switch(params: NodeParams): NodeRef<"switch"> {
    return createNodeRef("switch", params);
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
