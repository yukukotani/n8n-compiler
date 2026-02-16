import { expect, test, describe } from "bun:test";
import { transformParameters } from "../../src/compiler/transform-params";

describe("transformParameters", () => {
  describe("httpRequest v1", () => {
    test("method を requestMethod にリネームする", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 1, {
        method: "GET",
        url: "https://example.com/api",
      });

      expect(result).toEqual({
        requestMethod: "GET",
        url: "https://example.com/api",
      });
    });

    test("POST メソッドも正しく変換する", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 1, {
        method: "POST",
        url: "https://example.com/api/process",
      });

      expect(result).toEqual({
        requestMethod: "POST",
        url: "https://example.com/api/process",
      });
    });

    test("method がないパラメータはそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 1, {
        url: "https://example.com/api",
      });

      expect(result).toEqual({
        url: "https://example.com/api",
      });
    });
  });

  describe("set v1", () => {
    test("文字列値を fixedCollection の string 形式に変換する", () => {
      const result = transformParameters("n8n-nodes-base.set", 1, {
        values: {
          status: "ok",
        },
      });

      expect(result).toEqual({
        values: {
          string: [{ name: "status", value: "ok" }],
        },
      });
    });

    test("数値を fixedCollection の number 形式に変換する", () => {
      const result = transformParameters("n8n-nodes-base.set", 1, {
        values: {
          count: 42,
        },
      });

      expect(result).toEqual({
        values: {
          number: [{ name: "count", value: 42 }],
        },
      });
    });

    test("真偽値を fixedCollection の boolean 形式に変換する", () => {
      const result = transformParameters("n8n-nodes-base.set", 1, {
        values: {
          active: true,
        },
      });

      expect(result).toEqual({
        values: {
          boolean: [{ name: "active", value: true }],
        },
      });
    });

    test("混合型の値を正しく分類する", () => {
      const result = transformParameters("n8n-nodes-base.set", 1, {
        values: {
          status: "ok",
          count: 42,
          active: true,
        },
      });

      expect(result).toEqual({
        values: {
          string: [{ name: "status", value: "ok" }],
          number: [{ name: "count", value: 42 }],
          boolean: [{ name: "active", value: true }],
        },
      });
    });

    test("空の values はそのまま空オブジェクトになる", () => {
      const result = transformParameters("n8n-nodes-base.set", 1, {
        values: {},
      });

      expect(result).toEqual({
        values: {},
      });
    });

    test("values がないパラメータはそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.set", 1, {
        keepOnlySet: true,
      });

      expect(result).toEqual({
        keepOnlySet: true,
      });
    });
  });

  describe("if", () => {
    test("expression を n8n conditions 形式に変換する", () => {
      const result = transformParameters("n8n-nodes-base.if", 1, {
        expression: "={{$json.ok === true}}",
      });

      expect(result).toEqual({
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: "",
            typeValidation: "strict",
          },
          conditions: [
            {
              leftValue: "={{$json.ok === true}}",
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
      });
    });

    test("expression がないパラメータはそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.if", 1, {});

      expect(result).toEqual({});
    });
  });

  describe("manualTrigger", () => {
    test("空パラメータはそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.manualTrigger", 1, {});

      expect(result).toEqual({});
    });
  });

  describe("scheduleTrigger", () => {
    test("seconds スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [{ type: "seconds", intervalSeconds: 30 }],
      });

      expect(result).toEqual({
        rule: { interval: [{ field: "seconds", secondsInterval: 30 }] },
      });
    });

    test("minutes スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [{ type: "minutes", intervalMinutes: 5 }],
      });

      expect(result).toEqual({
        rule: { interval: [{ field: "minutes", minutesInterval: 5 }] },
      });
    });

    test("hours スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [{ type: "hours", intervalHours: 2, atMinute: 15 }],
      });

      expect(result).toEqual({
        rule: {
          interval: [{ field: "hours", hoursInterval: 2, triggerAtMinute: 15 }],
        },
      });
    });

    test("hours スケジュールの atMinute 省略時は triggerAtMinute を含めない", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [{ type: "hours", intervalHours: 1 }],
      });

      expect(result).toEqual({
        rule: { interval: [{ field: "hours", hoursInterval: 1 }] },
      });
    });

    test("days スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [{ type: "days", intervalDays: 2, atHour: 9, atMinute: 30 }],
      });

      expect(result).toEqual({
        rule: {
          interval: [{ field: "days", daysInterval: 2, triggerAtHour: 9, triggerAtMinute: 30 }],
        },
      });
    });

    test("weeks スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [
          {
            type: "weeks",
            intervalWeeks: 1,
            onWeekdays: ["monday"],
            atHour: 9,
            atMinute: 0,
          },
        ],
      });

      expect(result).toEqual({
        rule: {
          interval: [
            {
              field: "weeks",
              weeksInterval: 1,
              triggerOnWeekdays: ["monday"],
              triggerAtHour: 9,
              triggerAtMinute: 0,
            },
          ],
        },
      });
    });

    test("months スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [
          {
            type: "months",
            intervalMonths: 3,
            atDayOfMonth: 15,
            atHour: 10,
            atMinute: 0,
          },
        ],
      });

      expect(result).toEqual({
        rule: {
          interval: [
            {
              field: "months",
              monthsInterval: 3,
              triggerAtDayOfMonth: 15,
              triggerAtHour: 10,
              triggerAtMinute: 0,
            },
          ],
        },
      });
    });

    test("cron スケジュールを n8n interval に変換する", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [{ type: "cron", expression: "*/5 * * * *" }],
      });

      expect(result).toEqual({
        rule: { interval: [{ field: "cronExpression", expression: "*/5 * * * *" }] },
      });
    });

    test("複数スケジュールを一度に変換できる", () => {
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, {
        schedules: [
          { type: "minutes", intervalMinutes: 5 },
          { type: "cron", expression: "0 9 * * 1-5" },
        ],
      });

      expect(result).toEqual({
        rule: {
          interval: [
            { field: "minutes", minutesInterval: 5 },
            { field: "cronExpression", expression: "0 9 * * 1-5" },
          ],
        },
      });
    });
  });

  describe("noOp", () => {
    test("空パラメータはそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.noOp", 1, {});

      expect(result).toEqual({});
    });
  });

  describe("未知のノードタイプ", () => {
    test("パラメータをそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.unknown", 1, {
        foo: "bar",
      });

      expect(result).toEqual({
        foo: "bar",
      });
    });
  });
});
