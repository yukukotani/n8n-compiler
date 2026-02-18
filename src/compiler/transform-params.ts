import type { JsonObject } from "./ast-json";

/**
 * Transforms DSL-level parameters into n8n-compatible parameters
 * based on the node type and typeVersion.
 *
 * The DSL uses a simplified, user-friendly parameter format.
 * n8n nodes expect specific parameter schemas that differ per node type and version.
 */
export function transformParameters(
  n8nType: string,
  typeVersion: number,
  dslParams: JsonObject,
): JsonObject {
  const transformer = TRANSFORMERS[n8nType];
  if (!transformer) {
    return dslParams;
  }

  return transformer(typeVersion, dslParams);
}

type ParamTransformer = (typeVersion: number, params: JsonObject) => JsonObject;

const TRANSFORMERS: Record<string, ParamTransformer> = {
  "n8n-nodes-base.httpRequest": transformHttpRequest,
  "n8n-nodes-base.set": transformSet,
  "n8n-nodes-base.if": transformIf,
  "n8n-nodes-base.switch": transformSwitch,
  "n8n-nodes-base.scheduleTrigger": transformScheduleTrigger,
};

/**
 * HttpRequest v1 uses `requestMethod` instead of `method`.
 * v4+ uses `method` directly, so no transform is needed.
 *
 * Also converts `jsonBody` from a plain JS object/array back to n8n's
 * `={...}` expression format.
 *
 * DSL:  { method: "GET", url: "https://..." }
 * n8n v1:  { requestMethod: "GET", url: "https://..." }
 * n8n v4+: { method: "GET", url: "https://..." }
 *
 * DSL:  { jsonBody: { foo: "bar" } }
 * n8n:  { jsonBody: "={ \"foo\": \"bar\" }" }
 */
function transformHttpRequest(typeVersion: number, params: JsonObject): JsonObject {
  const result = { ...params };

  if (typeVersion < 4 && "method" in result) {
    result.requestMethod = result.method;
    delete result.method;
  }

  if ("jsonBody" in result && result.jsonBody !== null && result.jsonBody !== undefined) {
    const jsonBody = result.jsonBody;
    if (typeof jsonBody === "object") {
      result.jsonBody = `=${JSON.stringify(jsonBody)}`;
    }
  }

  return result;
}

/**
 * Set v1/v2 uses a fixedCollection format for `values`.
 *
 * DSL:  { values: { status: "ok", count: 42, active: true } }
 * n8n:  { values: { string: [{ name: "status", value: "ok" }],
 *                    number: [{ name: "count", value: 42 }],
 *                    boolean: [{ name: "active", value: true }] } }
 */
function transformSet(_typeVersion: number, params: JsonObject): JsonObject {
  const result = { ...params };

  if ("values" in result && isPlainObject(result.values)) {
    result.values = transformSetValues(result.values as Record<string, unknown>) as unknown as JsonObject[keyof JsonObject];
  }

  return result;
}

type SetFixedCollectionEntry = { name: string; value: unknown };

function transformSetValues(
  values: Record<string, unknown>,
): Record<string, SetFixedCollectionEntry[]> {
  const stringEntries: SetFixedCollectionEntry[] = [];
  const numberEntries: SetFixedCollectionEntry[] = [];
  const booleanEntries: SetFixedCollectionEntry[] = [];

  for (const [name, value] of Object.entries(values)) {
    switch (typeof value) {
      case "number":
        numberEntries.push({ name, value });
        break;
      case "boolean":
        booleanEntries.push({ name, value });
        break;
      default:
        // strings, null, objects, etc. all go into string entries
        stringEntries.push({ name, value: String(value) });
        break;
    }
  }

  const result: Record<string, SetFixedCollectionEntry[]> = {};

  if (stringEntries.length > 0) {
    result.string = stringEntries;
  }
  if (numberEntries.length > 0) {
    result.number = numberEntries;
  }
  if (booleanEntries.length > 0) {
    result.boolean = booleanEntries;
  }

  return result;
}

/**
 * If node uses a `conditions` parameter with combinator format.
 *
 * DSL (IR):  { expression: "={{$json.ok === true}}" }
 * n8n:       { conditions: { conditions: [{ leftValue: "={{$json.ok === true}}", rightValue: "",
 *               operator: { type: "boolean", operation: "true" } }], combinator: "and" },
 *             options: {} }
 */
function transformIf(_typeVersion: number, params: JsonObject): JsonObject {
  if ("expression" in params && typeof params.expression === "string") {
    return {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "strict",
        },
        conditions: [
          {
            leftValue: params.expression,
            rightValue: true,
            operator: {
              type: "boolean",
              operation: "true",
            },
          },
        ],
        combinator: "and",
      },
      options: {},
    };
  }

  return params;
}

/**
 * Switch node (MVP internal form)
 *
 * DSL/IR: { expression: "={{...}}", cases: [{ value: <literal> }, ...] }
 * n8n-ish: { mode: "rules", value: "={{...}}", rules: { values: [...] }, fallbackOutput: "extra" }
 */
function transformSwitch(_typeVersion: number, params: JsonObject): JsonObject {
  if (typeof params.expression !== "string" || !Array.isArray(params.cases)) {
    return params;
  }

  const rules = params.cases
    .map((entry, index) => {
      if (!isPlainObject(entry) || !("value" in entry)) {
        return null;
      }

      const value = (entry as Record<string, unknown>).value;
      if (!isSwitchLiteral(value)) {
        return null;
      }

      return {
        outputIndex: index,
        operation: "equal",
        value,
      };
    })
    .filter((entry): entry is { outputIndex: number; operation: "equal"; value: SwitchLiteral } => {
      return entry !== null;
    });

  return {
    mode: "rules",
    value: params.expression,
    rules: {
      values: rules,
    },
    fallbackOutput: "extra",
  };
}

type SwitchLiteral = string | number | boolean | null;

function isSwitchLiteral(value: unknown): value is SwitchLiteral {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * ScheduleTrigger uses ergonomic `schedules` array in the DSL.
 *
 * DSL:  { schedules: [{ type: "days", intervalDays: 2, atHour: 9, atMinute: 30 }] }
 * n8n:  { rule: { interval: [{ field: "days", daysInterval: 2, triggerAtHour: 9, triggerAtMinute: 30 }] } }
 */
function transformScheduleTrigger(_typeVersion: number, params: JsonObject): JsonObject {
  if (!("schedules" in params) || !Array.isArray(params.schedules)) {
    return params;
  }

  const interval = (params.schedules as JsonObject[]).map(transformScheduleEntry);

  return {
    rule: { interval } as unknown as JsonObject[keyof JsonObject],
  } as JsonObject;
}

type N8nInterval = Record<string, unknown>;

function transformScheduleEntry(schedule: JsonObject): N8nInterval {
  const type = schedule.type as string;

  switch (type) {
    case "seconds":
      return {
        field: "seconds",
        secondsInterval: schedule.intervalSeconds,
      };
    case "minutes":
      return {
        field: "minutes",
        minutesInterval: schedule.intervalMinutes,
      };
    case "hours":
      return {
        field: "hours",
        hoursInterval: schedule.intervalHours,
        ...(schedule.atMinute != null && { triggerAtMinute: schedule.atMinute }),
      };
    case "days":
      return {
        field: "days",
        daysInterval: schedule.intervalDays,
        ...(schedule.atHour != null && { triggerAtHour: schedule.atHour }),
        ...(schedule.atMinute != null && { triggerAtMinute: schedule.atMinute }),
      };
    case "weeks":
      return {
        field: "weeks",
        weeksInterval: schedule.intervalWeeks,
        ...(schedule.onWeekdays != null && { triggerOnWeekdays: schedule.onWeekdays }),
        ...(schedule.atHour != null && { triggerAtHour: schedule.atHour }),
        ...(schedule.atMinute != null && { triggerAtMinute: schedule.atMinute }),
      };
    case "months":
      return {
        field: "months",
        monthsInterval: schedule.intervalMonths,
        ...(schedule.atDayOfMonth != null && { triggerAtDayOfMonth: schedule.atDayOfMonth }),
        ...(schedule.atHour != null && { triggerAtHour: schedule.atHour }),
        ...(schedule.atMinute != null && { triggerAtMinute: schedule.atMinute }),
      };
    case "cron":
      return {
        field: "cronExpression",
        expression: schedule.expression,
      };
    default:
      return schedule;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
