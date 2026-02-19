import type {
  ConditionRef,
  ConnectOptions,
  ExpressionValue,
  LoopIterable,
  LoopOptions,
  LoopToken,
  NodeKind,
  NodeOptions,
  NodeParamsOf,
  NodeRef,
} from "./types";

const LOOP_SOURCE: LoopToken[] = [];

function createNodeRef<
  Kind extends NodeKind,
  Params extends NodeParamsOf<Kind>,
>(kind: Kind, params: Params): NodeRef<Kind, Params> {
  return {
    __brand: "NodeRef",
    kind,
    params,
  };
}

export const n = {
  manualTrigger(
    params: NodeParamsOf<"manualTrigger"> = {},
    _options?: NodeOptions,
  ): NodeRef<"manualTrigger"> {
    return createNodeRef("manualTrigger", params);
  },

  scheduleTrigger(
    params: NodeParamsOf<"scheduleTrigger">,
    _options?: NodeOptions,
  ): NodeRef<"scheduleTrigger"> {
    return createNodeRef("scheduleTrigger", params);
  },

  webhookTrigger(
    params: NodeParamsOf<"webhookTrigger"> = {},
    _options?: NodeOptions,
  ): NodeRef<"webhookTrigger"> {
    return createNodeRef("webhookTrigger", params);
  },

  googleCalendarTrigger(
    params: NodeParamsOf<"googleCalendarTrigger"> = {},
    _options?: NodeOptions,
  ): NodeRef<"googleCalendarTrigger"> {
    return createNodeRef("googleCalendarTrigger", params);
  },

  httpRequest(
    params: NodeParamsOf<"httpRequest">,
    _options?: NodeOptions,
  ): NodeRef<"httpRequest"> {
    return createNodeRef("httpRequest", params);
  },

  executeWorkflow(
    params: NodeParamsOf<"executeWorkflow">,
    _options?: NodeOptions,
  ): NodeRef<"executeWorkflow"> {
    return createNodeRef("executeWorkflow", params);
  },

  code(params: NodeParamsOf<"code">, _options?: NodeOptions): NodeRef<"code"> {
    return createNodeRef("code", params);
  },

  aggregate(
    params: NodeParamsOf<"aggregate">,
    _options?: NodeOptions,
  ): NodeRef<"aggregate"> {
    return createNodeRef("aggregate", params);
  },

  filter(
    params: NodeParamsOf<"filter">,
    _options?: NodeOptions,
  ): NodeRef<"filter"> {
    return createNodeRef("filter", params);
  },

  limit(
    params: NodeParamsOf<"limit">,
    _options?: NodeOptions,
  ): NodeRef<"limit"> {
    return createNodeRef("limit", params);
  },

  merge(
    params: NodeParamsOf<"merge">,
    _options?: NodeOptions,
  ): NodeRef<"merge"> {
    return createNodeRef("merge", params);
  },

  removeDuplicates(
    params: NodeParamsOf<"removeDuplicates">,
    _options?: NodeOptions,
  ): NodeRef<"removeDuplicates"> {
    return createNodeRef("removeDuplicates", params);
  },

  respondToWebhook(
    params: NodeParamsOf<"respondToWebhook">,
    _options?: NodeOptions,
  ): NodeRef<"respondToWebhook"> {
    return createNodeRef("respondToWebhook", params);
  },

  sort(params: NodeParamsOf<"sort">, _options?: NodeOptions): NodeRef<"sort"> {
    return createNodeRef("sort", params);
  },

  splitOut(
    params: NodeParamsOf<"splitOut">,
    _options?: NodeOptions,
  ): NodeRef<"splitOut"> {
    return createNodeRef("splitOut", params);
  },

  switch(
    params: NodeParamsOf<"switch">,
    _options?: NodeOptions,
  ): NodeRef<"switch"> {
    return createNodeRef("switch", params);
  },

  summarize(
    params: NodeParamsOf<"summarize">,
    _options?: NodeOptions,
  ): NodeRef<"summarize"> {
    return createNodeRef("summarize", params);
  },

  set(params: NodeParamsOf<"set">, _options?: NodeOptions): NodeRef<"set"> {
    return createNodeRef("set", params);
  },

  wait(params: NodeParamsOf<"wait">, _options?: NodeOptions): NodeRef<"wait"> {
    return createNodeRef("wait", params);
  },

  noOp(
    params: NodeParamsOf<"noOp"> = {},
    _options?: NodeOptions,
  ): NodeRef<"noOp"> {
    return createNodeRef("noOp", params);
  },

  formTrigger(
    params: NodeParamsOf<"formTrigger"> = {},
    _options?: NodeOptions,
  ): NodeRef<"formTrigger"> {
    return createNodeRef("formTrigger", params);
  },

  executeWorkflowTrigger(
    params: NodeParamsOf<"executeWorkflowTrigger"> = {},
    _options?: NodeOptions,
  ): NodeRef<"executeWorkflowTrigger"> {
    return createNodeRef("executeWorkflowTrigger", params);
  },

  googleCalendar(
    params: NodeParamsOf<"googleCalendar">,
    _options?: NodeOptions,
  ): NodeRef<"googleCalendar"> {
    return createNodeRef("googleCalendar", params);
  },

  googleSheets(
    params: NodeParamsOf<"googleSheets">,
    _options?: NodeOptions,
  ): NodeRef<"googleSheets"> {
    return createNodeRef("googleSheets", params);
  },

  itemLists(
    params: NodeParamsOf<"itemLists">,
    _options?: NodeOptions,
  ): NodeRef<"itemLists"> {
    return createNodeRef("itemLists", params);
  },

  langchainAgent(
    params: NodeParamsOf<"langchainAgent">,
    _options?: NodeOptions,
  ): NodeRef<"langchainAgent"> {
    return createNodeRef("langchainAgent", params);
  },

  lmChatGoogleVertex(
    params: NodeParamsOf<"lmChatGoogleVertex">,
    _options?: NodeOptions,
  ): NodeRef<"lmChatGoogleVertex"> {
    return createNodeRef("lmChatGoogleVertex", params);
  },

  /**
   * Creates a non-main connection (e.g. ai_languageModel, ai_tool) between a source node
   * and a target node identified by display name.
   *
   * The source node is created but NOT connected to the main execution flow.
   * The compiler generates an edge with the specified connection type.
   *
   * @example
   * n.connect(
   *   n.lmChatGoogleVertex({ projectId: "my-project" }, { name: "My Model", credentials: ... }),
   *   "My Agent",
   *   { type: "ai_languageModel" }
   * );
   */
  connect(
    _sourceNode: NodeRef,
    _targetNodeName: string,
    _options: ConnectOptions,
  ): void {
    // no-op at runtime; the compiler handles this statically
  },

  parallel<T extends Array<() => NodeRef>>(
    ..._branches: T
  ): { [K in keyof T]: ReturnType<T[K]> } {
    // no-op at runtime; the compiler handles this statically
    return [] as never;
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
