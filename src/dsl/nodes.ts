import type {
  ConditionRef,
  ExpressionValue,
  LoopIterable,
  LoopOptions,
  LoopToken,
  NodeKind,
  NodeParamsOf,
  NodeRef,
} from "./types";

const LOOP_SOURCE: LoopToken[] = [];

function createNodeRef<Kind extends NodeKind, Params extends NodeParamsOf<Kind>>(
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
  manualTrigger(params: NodeParamsOf<"manualTrigger"> = {}): NodeRef<"manualTrigger"> {
    return createNodeRef("manualTrigger", params);
  },

  scheduleTrigger(params: NodeParamsOf<"scheduleTrigger">): NodeRef<"scheduleTrigger"> {
    return createNodeRef("scheduleTrigger", params);
  },

  webhookTrigger(params: NodeParamsOf<"webhookTrigger"> = {}): NodeRef<"webhookTrigger"> {
    return createNodeRef("webhookTrigger", params);
  },

  httpRequest(params: NodeParamsOf<"httpRequest">): NodeRef<"httpRequest"> {
    return createNodeRef("httpRequest", params);
  },

  executeWorkflow(params: NodeParamsOf<"executeWorkflow">): NodeRef<"executeWorkflow"> {
    return createNodeRef("executeWorkflow", params);
  },

  code(params: NodeParamsOf<"code">): NodeRef<"code"> {
    return createNodeRef("code", params);
  },

  aggregate(params: NodeParamsOf<"aggregate">): NodeRef<"aggregate"> {
    return createNodeRef("aggregate", params);
  },

  filter(params: NodeParamsOf<"filter">): NodeRef<"filter"> {
    return createNodeRef("filter", params);
  },

  limit(params: NodeParamsOf<"limit">): NodeRef<"limit"> {
    return createNodeRef("limit", params);
  },

  merge(params: NodeParamsOf<"merge">): NodeRef<"merge"> {
    return createNodeRef("merge", params);
  },

  removeDuplicates(params: NodeParamsOf<"removeDuplicates">): NodeRef<"removeDuplicates"> {
    return createNodeRef("removeDuplicates", params);
  },

  respondToWebhook(params: NodeParamsOf<"respondToWebhook">): NodeRef<"respondToWebhook"> {
    return createNodeRef("respondToWebhook", params);
  },

  sort(params: NodeParamsOf<"sort">): NodeRef<"sort"> {
    return createNodeRef("sort", params);
  },

  splitOut(params: NodeParamsOf<"splitOut">): NodeRef<"splitOut"> {
    return createNodeRef("splitOut", params);
  },

  switch(params: NodeParamsOf<"switch">): NodeRef<"switch"> {
    return createNodeRef("switch", params);
  },

  summarize(params: NodeParamsOf<"summarize">): NodeRef<"summarize"> {
    return createNodeRef("summarize", params);
  },

  set(params: NodeParamsOf<"set">): NodeRef<"set"> {
    return createNodeRef("set", params);
  },

  wait(params: NodeParamsOf<"wait">): NodeRef<"wait"> {
    return createNodeRef("wait", params);
  },

  noOp(params: NodeParamsOf<"noOp"> = {}): NodeRef<"noOp"> {
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
