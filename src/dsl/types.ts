export type JsonObject = Record<string, unknown>;

export type WorkflowSettings = JsonObject;

export type WorkflowExecute = () => void | Promise<void>;

export type TriggerNodeKind = "manualTrigger" | "scheduleTrigger";

// --- Schedule Trigger params ---

export type ScheduleTriggerInterval =
  | {
      field: "seconds";
      secondsInterval: number;
    }
  | {
      field: "minutes";
      minutesInterval: number;
    }
  | {
      field: "hours";
      hoursInterval: number;
      triggerAtMinute?: number;
    }
  | {
      field: "days";
      daysInterval: number;
      triggerAtHour?: number;
      triggerAtMinute?: number;
    }
  | {
      field: "weeks";
      weeksInterval: number;
      triggerOnWeekdays?: string[];
      triggerAtHour?: number;
      triggerAtMinute?: number;
    }
  | {
      field: "months";
      monthsInterval: number;
      triggerAtDayOfMonth?: number;
      triggerAtHour?: number;
      triggerAtMinute?: number;
    }
  | {
      field: "cronExpression";
      expression: string;
    };

export type ScheduleTriggerParams = {
  rule: {
    interval: ScheduleTriggerInterval[];
  };
};

export type WorkflowDefinition = {
  name: string;
  settings?: WorkflowSettings;
  triggers: NodeRef<TriggerNodeKind>[];
  execute: WorkflowExecute;
};

export type NodeParams = JsonObject;

export type NodeKind = "manualTrigger" | "scheduleTrigger" | "httpRequest" | "set" | "noOp";

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
