import { expect, test, describe } from "bun:test";
import { normalizeParameters } from "../../src/importer/normalize-params";

describe("normalizeParameters", () => {
  describe("httpRequest v1", () => {
    test("requestMethod を method にリネームする", () => {
      const result = normalizeParameters("n8n-nodes-base.httpRequest", 1, {
        requestMethod: "GET",
        url: "https://example.com",
      });
      expect(result).toEqual({ method: "GET", url: "https://example.com" });
    });

    test("v4+ はそのまま", () => {
      const result = normalizeParameters("n8n-nodes-base.httpRequest", 4.2, {
        method: "POST",
        url: "https://example.com",
      });
      expect(result).toEqual({ method: "POST", url: "https://example.com" });
    });
  });

  describe("set", () => {
    test("fixedCollection 形式を簡易 values に逆変換する", () => {
      const result = normalizeParameters("n8n-nodes-base.set", 1, {
        values: {
          string: [{ name: "status", value: "ok" }],
          number: [{ name: "count", value: 42 }],
          boolean: [{ name: "active", value: true }],
        },
      });
      expect(result).toEqual({
        values: { status: "ok", count: 42, active: true },
      });
    });

    test("assignments 形式はそのまま通す", () => {
      const params = {
        assignments: {
          assignments: [{ name: "x", value: "y", type: "string" }],
        },
      };
      const result = normalizeParameters("n8n-nodes-base.set", 1, params);
      expect(result).toEqual(params);
    });
  });

  describe("if", () => {
    test("conditions 形式を expression に逆変換する", () => {
      const result = normalizeParameters("n8n-nodes-base.if", 2, {
        conditions: {
          conditions: [
            {
              leftValue: "={{$json.ok}}",
              rightValue: true,
              operator: { type: "boolean", operation: "true" },
            },
          ],
          combinator: "and",
          options: {},
        },
        options: {},
      });
      expect(result).toEqual({ expression: "={{$json.ok}}" });
    });
  });

  describe("switch", () => {
    test("rules 形式を expression/cases に逆変換する", () => {
      const result = normalizeParameters("n8n-nodes-base.switch", 3, {
        mode: "rules",
        value: '={{$node["req"].json.status}}',
        rules: {
          values: [
            { outputIndex: 0, operation: "equal", value: 200 },
            { outputIndex: 1, operation: "equal", value: "ok" },
          ],
        },
        fallbackOutput: "extra",
      });
      expect(result).toEqual({
        expression: '={{$node["req"].json.status}}',
        cases: [{ value: 200 }, { value: "ok" }],
      });
    });
  });

  describe("scheduleTrigger", () => {
    test("n8n interval を DSL schedules に逆変換する", () => {
      const result = normalizeParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        rule: {
          interval: [
            { field: "days", daysInterval: 2, triggerAtHour: 9, triggerAtMinute: 30 },
          ],
        },
      });
      expect(result).toEqual({
        schedules: [
          { type: "days", intervalDays: 2, atHour: 9, atMinute: 30 },
        ],
      });
    });

    test("cron を逆変換する", () => {
      const result = normalizeParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        rule: {
          interval: [{ field: "cronExpression", expression: "*/5 * * * *" }],
        },
      });
      expect(result).toEqual({
        schedules: [{ type: "cron", expression: "*/5 * * * *" }],
      });
    });
  });

  describe("未知のノード", () => {
    test("パラメータをそのまま通す", () => {
      const result = normalizeParameters("n8n-nodes-base.unknown", 1, { foo: "bar" });
      expect(result).toEqual({ foo: "bar" });
    });
  });
});
