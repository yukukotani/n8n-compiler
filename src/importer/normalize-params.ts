/**
 * Reverse-transforms n8n node parameters back to DSL-friendly format.
 *
 * This is the inverse of `src/compiler/transform-params.ts`.
 */

type JsonObject = Record<string, unknown>;

export function normalizeParameters(
  n8nType: string,
  typeVersion: number,
  params: JsonObject,
): JsonObject {
  const normalizer = NORMALIZERS[n8nType];
  if (!normalizer) {
    return params;
  }
  return normalizer(typeVersion, params);
}

type ParamNormalizer = (typeVersion: number, params: JsonObject) => JsonObject;

const NORMALIZERS: Record<string, ParamNormalizer> = {
  "n8n-nodes-base.httpRequest": normalizeHttpRequest,
  "n8n-nodes-base.set": normalizeSet,
  "n8n-nodes-base.if": normalizeIf,
  "n8n-nodes-base.switch": normalizeSwitch,
  "n8n-nodes-base.scheduleTrigger": normalizeScheduleTrigger,
};

/**
 * httpRequest v1 uses `requestMethod` instead of `method`.
 * Reverse: rename `requestMethod` back to `method` for v1.
 */
function normalizeHttpRequest(typeVersion: number, params: JsonObject): JsonObject {
  if (typeVersion >= 4) {
    return params;
  }

  const result = { ...params };
  if ("requestMethod" in result) {
    result.method = result.requestMethod;
    delete result.requestMethod;
  }
  return result;
}

/**
 * set v1/v2 uses fixedCollection format.
 * Reverse: convert `{ string: [{name, value}], number: [...] }` back to
 * `{ key: value, ... }`.
 */
function normalizeSet(_typeVersion: number, params: JsonObject): JsonObject {
  const result = { ...params };

  if ("values" in result && isPlainObject(result.values)) {
    const values = result.values as Record<string, unknown>;
    // Check if it's in fixedCollection format (has string/number/boolean arrays)
    if (hasFixedCollectionShape(values)) {
      result.values = reverseSetValues(values) as unknown as JsonObject[keyof JsonObject];
    }
  }

  return result;
}

function hasFixedCollectionShape(values: Record<string, unknown>): boolean {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return false;
  }
  return keys.every((k) => ["string", "number", "boolean"].includes(k) && Array.isArray(values[k]));
}

type FixedCollectionEntry = { name: string; value: unknown };

function reverseSetValues(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const entries of Object.values(values)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as FixedCollectionEntry[]) {
      if (entry && typeof entry.name === "string") {
        result[entry.name] = entry.value;
      }
    }
  }

  return result;
}

/**
 * If node: n8n `conditions` format → DSL `{ expression: "={{...}}" }`.
 *
 * Only handles the single-condition boolean-true pattern that the compiler generates.
 * Other patterns are passed through as-is.
 */
function normalizeIf(_typeVersion: number, params: JsonObject): JsonObject {
  if (!isPlainObject(params.conditions)) {
    return params;
  }

  const conditions = params.conditions as Record<string, unknown>;
  if (!Array.isArray(conditions.conditions) || conditions.conditions.length !== 1) {
    return params;
  }

  const condition = conditions.conditions[0] as Record<string, unknown> | undefined;
  if (!condition) {
    return params;
  }

  const operator = condition.operator as Record<string, unknown> | undefined;
  if (
    operator?.type === "boolean" &&
    operator?.operation === "true" &&
    typeof condition.leftValue === "string" &&
    condition.leftValue.startsWith("={{")
  ) {
    return { expression: condition.leftValue };
  }

  return params;
}

/**
 * Switch node: n8n `{ mode: "rules", value, rules, fallbackOutput }` →
 * DSL `{ expression, cases }`.
 */
function normalizeSwitch(_typeVersion: number, params: JsonObject): JsonObject {
  if (params.mode !== "rules" || typeof params.value !== "string") {
    return params;
  }

  if (!isPlainObject(params.rules)) {
    return params;
  }

  const rules = params.rules as Record<string, unknown>;
  if (!Array.isArray(rules.values)) {
    return params;
  }

  const cases = (rules.values as Array<Record<string, unknown>>)
    .sort((a, b) => (a.outputIndex as number) - (b.outputIndex as number))
    .map((rule) => ({ value: rule.value }));

  return {
    expression: params.value,
    cases,
  };
}

/**
 * ScheduleTrigger: n8n `{ rule: { interval: [...] } }` →
 * DSL `{ schedules: [...] }`.
 */
function normalizeScheduleTrigger(_typeVersion: number, params: JsonObject): JsonObject {
  if (!isPlainObject(params.rule)) {
    return params;
  }

  const rule = params.rule as Record<string, unknown>;
  if (!Array.isArray(rule.interval)) {
    return params;
  }

  const schedules = (rule.interval as JsonObject[]).map(normalizeScheduleEntry);
  return { schedules };
}

function normalizeScheduleEntry(entry: JsonObject): JsonObject {
  const field = entry.field as string;

  switch (field) {
    case "seconds":
      return { type: "seconds", intervalSeconds: entry.secondsInterval };
    case "minutes":
      return { type: "minutes", intervalMinutes: entry.minutesInterval };
    case "hours":
      return {
        type: "hours",
        intervalHours: entry.hoursInterval,
        ...(entry.triggerAtMinute != null && { atMinute: entry.triggerAtMinute }),
      };
    case "days":
      return {
        type: "days",
        intervalDays: entry.daysInterval,
        ...(entry.triggerAtHour != null && { atHour: entry.triggerAtHour }),
        ...(entry.triggerAtMinute != null && { atMinute: entry.triggerAtMinute }),
      };
    case "weeks":
      return {
        type: "weeks",
        intervalWeeks: entry.weeksInterval,
        ...(entry.triggerOnWeekdays != null && { onWeekdays: entry.triggerOnWeekdays }),
        ...(entry.triggerAtHour != null && { atHour: entry.triggerAtHour }),
        ...(entry.triggerAtMinute != null && { atMinute: entry.triggerAtMinute }),
      };
    case "months":
      return {
        type: "months",
        intervalMonths: entry.monthsInterval,
        ...(entry.triggerAtDayOfMonth != null && { atDayOfMonth: entry.triggerAtDayOfMonth }),
        ...(entry.triggerAtHour != null && { atHour: entry.triggerAtHour }),
        ...(entry.triggerAtMinute != null && { atMinute: entry.triggerAtMinute }),
      };
    case "cronExpression":
      return { type: "cron", expression: entry.expression };
    default:
      return entry;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
