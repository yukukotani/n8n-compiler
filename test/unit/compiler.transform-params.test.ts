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

  describe("switch", () => {
    test("expression/cases を switch の rules 形式に変換する", () => {
      const result = transformParameters("n8n-nodes-base.switch", 3, {
        expression: '={{$node["req"].json.status}}',
        cases: [{ value: 200 }, { value: "ok" }, { value: null }],
      });

      expect(result).toEqual({
        mode: "rules",
        value: '={{$node["req"].json.status}}',
        rules: {
          values: [
            { outputIndex: 0, operation: "equal", value: 200 },
            { outputIndex: 1, operation: "equal", value: "ok" },
            { outputIndex: 2, operation: "equal", value: null },
          ],
        },
        fallbackOutput: "extra",
      });
    });

    test("内部表現でないパラメータはそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.switch", 3, {
        mode: "rules",
        foo: "bar",
      });

      expect(result).toEqual({
        mode: "rules",
        foo: "bar",
      });
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

  describe("httpRequest jsonBody", () => {
    test("object の jsonBody を ={...} 文字列に変換する", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 4.2, {
        method: "POST",
        url: "https://example.com",
        sendBody: true,
        specifyBody: "json",
        jsonBody: { foo: "bar" },
      });

      expect(result.jsonBody).toBe('={"foo":"bar"}');
    });

    test("配列の jsonBody を =[...] 文字列に変換する", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 4.2, {
        jsonBody: [1, 2, 3],
      });

      expect(result.jsonBody).toBe("=[1,2,3]");
    });

    test("文字列の jsonBody はそのまま通す", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 4.2, {
        jsonBody: "={{$json}}",
      });

      expect(result.jsonBody).toBe("={{$json}}");
    });

    test("={}（空オブジェクト）の jsonBody", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 4.2, {
        jsonBody: {},
      });

      expect(result.jsonBody).toBe("={}");
    });

    test("v1 でも jsonBody の object→文字列変換と method→requestMethod を両方行う", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 1, {
        method: "POST",
        jsonBody: { key: "value" },
      });

      expect(result.requestMethod).toBe("POST");
      expect(result.method).toBeUndefined();
      expect(result.jsonBody).toBe('={"key":"value"}');
    });
  });

  describe("httpRequest v4+", () => {
    test("method をそのまま保持する（v4 以上は requestMethod へのリネーム不要）", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 4.2, {
        method: "POST",
        url: "https://example.com/api",
        authentication: "predefinedCredentialType",
        sendBody: true,
      });

      expect(result).toEqual({
        method: "POST",
        url: "https://example.com/api",
        authentication: "predefinedCredentialType",
        sendBody: true,
      });
    });

    test("v4.0 でも method をそのまま保持する", () => {
      const result = transformParameters("n8n-nodes-base.httpRequest", 4, {
        method: "GET",
        url: "https://example.com",
      });

      expect(result).toEqual({
        method: "GET",
        url: "https://example.com",
      });
    });
  });
});
