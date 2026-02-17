import { expect, test, describe } from "bun:test";
import { extractWorkflowId } from "../../src/importer/extract-workflow-id";

describe("extractWorkflowId", () => {
  test("数値 ID をそのまま返す", () => {
    expect(extractWorkflowId("123")).toEqual({ id: "123" });
  });

  test("英数字ハイフン ID を返す", () => {
    expect(extractWorkflowId("wf-abc-123")).toEqual({ id: "wf-abc-123" });
  });

  test("n8n エディタ URL から id と baseUrl を抽出する", () => {
    const result = extractWorkflowId("https://n8n.example.com/workflow/42");
    expect(result).toEqual({
      id: "42",
      baseUrl: "https://n8n.example.com",
    });
  });

  test("サブパス付き URL から正しく抽出する", () => {
    const result = extractWorkflowId("https://n8n.example.com/n8n/workflow/999");
    expect(result).toEqual({
      id: "999",
      baseUrl: "https://n8n.example.com/n8n",
    });
  });

  test("フラグメント付き URL からも id を抽出する", () => {
    const result = extractWorkflowId("https://n8n.example.com/workflow/abc#settings");
    expect(result).toEqual({
      id: "abc",
      baseUrl: "https://n8n.example.com",
    });
  });

  test("末尾スラッシュ付き URL を処理する", () => {
    const result = extractWorkflowId("https://n8n.example.com/workflow/55/");
    expect(result).toEqual({
      id: "55",
      baseUrl: "https://n8n.example.com",
    });
  });

  test("空文字は null を返す", () => {
    expect(extractWorkflowId("")).toBeNull();
    expect(extractWorkflowId("  ")).toBeNull();
  });

  test("/workflow/ を含まない URL は null を返す", () => {
    expect(extractWorkflowId("https://n8n.example.com/api/v1/workflows")).toBeNull();
  });

  test("不正な文字列は null を返す", () => {
    expect(extractWorkflowId("not a valid id/path")).toBeNull();
  });
});
