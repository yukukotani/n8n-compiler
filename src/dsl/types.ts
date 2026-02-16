export type JsonObject = Record<string, unknown>;

export type WorkflowSettings = JsonObject;

export type WorkflowExecute = () => void | Promise<void>;

export type TriggerNodeKind = "manualTrigger" | "scheduleTrigger" | "webhookTrigger";

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

export type WorkflowDefinition = {
  name: string;
  settings?: WorkflowSettings;
  triggers: NodeRef<TriggerNodeKind>[];
  execute: WorkflowExecute;
};

export type NodeParams = JsonObject;

export type NodeKind =
  | "manualTrigger"
  | "scheduleTrigger"
  | "webhookTrigger"
  | "httpRequest"
  | "aggregate"
  | "filter"
  | "merge"
  | "respondToWebhook"
  | "splitOut"
  | "switch"
  | "set"
  | "wait"
  | "noOp";

export type ActionNodeKind = Exclude<NodeKind, TriggerNodeKind>;

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
  Params extends NodeParams = NodeParams,
> = {
  readonly __brand: "NodeRef";
  readonly kind: Kind;
  readonly params: Params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [key: string]: any;
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
