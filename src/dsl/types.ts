export type JsonObject = Record<string, unknown>;

export type WorkflowSettings = JsonObject;

export type WorkflowExecute = () => void | Promise<void>;

export type ExpressionValue = `={{${string}}}`;

export type TriggerNodeKind = "manualTrigger" | "scheduleTrigger" | "webhookTrigger" | "googleCalendarTrigger";

// --- Schedule Trigger params ---

export type Schedule =
  | {
      type: "seconds";
      intervalSeconds: number;
    }
  | {
      type: "minutes";
      intervalMinutes: number;
    }
  | {
      type: "hours";
      intervalHours: number;
      atMinute?: number;
    }
  | {
      type: "days";
      intervalDays: number;
      atHour?: number;
      atMinute?: number;
    }
  | {
      type: "weeks";
      intervalWeeks: number;
      onWeekdays?: string[];
      atHour?: number;
      atMinute?: number;
    }
  | {
      type: "months";
      intervalMonths: number;
      atDayOfMonth?: number;
      atHour?: number;
      atMinute?: number;
    }
  | {
      type: "cron";
      expression: string;
    };

export type ScheduleTriggerParams = {
  schedules: Schedule[];
};

export type EmptyNodeParams = Record<string, never>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type ManualTriggerParams = EmptyNodeParams;

export type WebhookTriggerParams = {
  path?: string;
  httpMethod?: HttpMethod;
  responseMode?: "onReceived" | "lastNode" | "responseNode";
};

export type HttpRequestParams = {
  method?: HttpMethod;
  url?: string;
  authentication?: "none" | "predefinedCredentialType" | "genericCredentialType" | string;
  nodeCredentialType?: string;
  sendBody?: boolean;
  specifyBody?: "json" | "string" | "raw";
  jsonBody?: string | ExpressionValue;
  options?: JsonObject;
};

export type GoogleCalendarTriggerParams = JsonObject;

export type GoogleCalendarParams = JsonObject;

export type ExecuteWorkflowParams = {
  workflowId: string;
  mode?: "once" | "each";
  options?: {
    waitForSubWorkflow?: boolean;
  };
};

type CodeMode = "runOnceForAllItems" | "runOnceForEachItem";

type JavascriptCodeParams = {
  mode?: CodeMode;
  language?: "javaScript";
  jsCode: string;
};

type PythonCodeParams = {
  mode?: CodeMode;
  language: "python";
  pythonCode: string;
};

export type CodeParams = JavascriptCodeParams | PythonCodeParams;

export type AggregateParams = {
  aggregate: "sum" | "average" | "min" | "max" | "count";
  field: string;
};

export type FilterCondition = {
  leftValue: string | number | boolean | null | ExpressionValue;
  rightValue: string | number | boolean | null | ExpressionValue;
  operator: {
    type: "string" | "number" | "boolean" | "dateTime" | "object" | "array";
    operation: string;
  };
};

export type FilterParams = {
  conditions: {
    conditions: FilterCondition[];
    combinator?: "and" | "or";
    options?: JsonObject;
  };
};

export type LimitParams = {
  maxItems: number;
  keep?: "firstItems" | "lastItems";
};

export type MergeParams = {
  mode: "append" | "combine" | "chooseBranch";
  mergeByFields?: {
    values: Array<{
      field1: string;
      field2: string;
    }>;
  };
  options?: JsonObject;
};

type RemoveDuplicatesSelectedFieldsParams = {
  fieldsToCompare: "selectedFields";
  fields: string | string[];
};

type RemoveDuplicatesAllFieldsParams = {
  fieldsToCompare: "allFields";
};

export type RemoveDuplicatesParams =
  | RemoveDuplicatesSelectedFieldsParams
  | RemoveDuplicatesAllFieldsParams;

export type RespondToWebhookParams = {
  respondWith: "allIncomingItems" | "firstIncomingItem" | "json" | "text" | "binaryFile" | "noData";
  responseBody?: string | ExpressionValue;
  responseCode?: number;
};

export type SortParams = {
  fields: Array<{
    fieldName: string;
    order: "ascending" | "descending";
  }>;
};

export type SplitOutParams = {
  fieldToSplitOut: string;
};

export type SwitchParams = {
  expression: string | ExpressionValue;
  cases: Array<{
    value: string | number | boolean | null;
  }>;
};

export type SummarizeParams = {
  fieldsToSummarize: string[];
};

export type SetValuesParams = {
  values: Record<string, unknown>;
  keepOnlySet?: boolean;
  options?: JsonObject;
};

export type SetAssignmentsParams = {
  assignments: {
    assignments: Array<{
      name: string;
      value: unknown;
      type: "string" | "number" | "boolean" | "json";
    }>;
  };
  options?: JsonObject;
};

export type SetParams = SetValuesParams | SetAssignmentsParams;

type WaitTimeIntervalParams = {
  resume?: "timeInterval";
  amount: number;
  unit: "seconds" | "minutes" | "hours" | "days";
};

type WaitUntilDateTimeParams = {
  resume: "specificTime";
  dateTime: string | ExpressionValue;
};

type WaitForWebhookParams = {
  resume: "webhook";
  webhookSuffix?: string;
};

export type WaitParams = WaitTimeIntervalParams | WaitUntilDateTimeParams | WaitForWebhookParams;

export type NoOpParams = EmptyNodeParams;

export type NodeKind =
  | "manualTrigger"
  | "scheduleTrigger"
  | "webhookTrigger"
  | "googleCalendarTrigger"
  | "httpRequest"
  | "executeWorkflow"
  | "code"
  | "aggregate"
  | "filter"
  | "limit"
  | "merge"
  | "removeDuplicates"
  | "respondToWebhook"
  | "sort"
  | "splitOut"
  | "switch"
  | "summarize"
  | "set"
  | "wait"
  | "noOp"
  | "googleCalendar";

export type ActionNodeKind = Exclude<NodeKind, TriggerNodeKind>;

export type NodeParamsByKind = {
  manualTrigger: ManualTriggerParams;
  scheduleTrigger: ScheduleTriggerParams;
  webhookTrigger: WebhookTriggerParams;
  googleCalendarTrigger: GoogleCalendarTriggerParams;
  httpRequest: HttpRequestParams;
  executeWorkflow: ExecuteWorkflowParams;
  code: CodeParams;
  aggregate: AggregateParams;
  filter: FilterParams;
  limit: LimitParams;
  merge: MergeParams;
  removeDuplicates: RemoveDuplicatesParams;
  respondToWebhook: RespondToWebhookParams;
  sort: SortParams;
  splitOut: SplitOutParams;
  switch: SwitchParams;
  summarize: SummarizeParams;
  set: SetParams;
  wait: WaitParams;
  noOp: NoOpParams;
  googleCalendar: GoogleCalendarParams;
};

export type NodeParamsOf<Kind extends NodeKind> = NodeParamsByKind[Kind];

export type NodeParams = NodeParamsOf<NodeKind>;

export type WorkflowDefinition = {
  name: string;
  settings?: WorkflowSettings;
  triggers: NodeRef<TriggerNodeKind>[];
  execute: WorkflowExecute;
};

/**
 * Node output reference.
 *
 * Supports arbitrary property access for referencing previous node output data.
 * The compiler converts these references into n8n expressions:
 *
 * - `ref`             → `={{$node["ref"].json}}`
 * - `ref.data`        → `={{$node["ref"].json.data}}`
 * - `ref.data.nested` → `={{$node["ref"].json.data.nested}}`
 * - `ref[0]`          → `={{$node["ref"].json[0]}}`
 * - `ref["key"]`      → `={{$node["ref"].json["key"]}}`
 */
export type NodeRef<
  Kind extends NodeKind = NodeKind,
  Params extends NodeParamsOf<Kind> = NodeParamsOf<Kind>,
> = {
  readonly __brand: "NodeRef";
  readonly kind: Kind;
  readonly params: Params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [key: string]: any;
};

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

export type NodeOptions = {
  credentials?: Record<string, { id: string; name?: string }>;
  name?: string;
  position?: [number, number];
};
