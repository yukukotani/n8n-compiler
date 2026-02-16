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
    test("rule パラメータをそのまま通す", () => {
      const params = {
        rule: {
          interval: [{ field: "minutes", minutesInterval: 5 }],
        },
      };
      const result = transformParameters("n8n-nodes-base.scheduleTrigger", 1.2, params);

      expect(result).toEqual(params);
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
