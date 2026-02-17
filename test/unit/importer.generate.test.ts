import { expect, test, describe } from "bun:test";
import { generateWorkflowCode, type N8nWorkflowInput } from "../../src/importer/generate";
import { compile } from "../../src/compiler/compile";

describe("generateWorkflowCode", () => {
  test("sequential ノードを正しくコード化する", () => {
    const workflow: N8nWorkflowInput = {
      name: "basic",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "done" }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: { timezone: "Asia/Tokyo" },
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain('n.httpRequest({ method: "GET", url: "https://example.com" })');
    expect(result.code).toContain('n.set({ value: "done" })');
    expect(result.code).toContain('n.manualTrigger()');
  });

  test("if ノードを if 文に復元する", () => {
    const workflow: N8nWorkflowInput = {
      name: "if-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "if_2", type: "n8n-nodes-base.if", typeVersion: 2,
          parameters: {
            conditions: {
              conditions: [{ leftValue: "={{$json.ok}}", rightValue: true, operator: { type: "boolean", operation: "true" } }],
              combinator: "and",
              options: {},
            },
            options: {},
          },
          position: [200, 0],
        },
        { name: "noOp_3", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 0] },
        { name: "noOp_4", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 200] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "if_2", type: "main", index: 0 }]] },
        if_2: {
          main: [
            [{ node: "noOp_3", type: "main", index: 0 }],
            [{ node: "noOp_4", type: "main", index: 0 }],
          ],
        },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain('if (n.expr("={{$json.ok}}"))');
    expect(result.code).toContain("} else {");
    expect(result.code).toContain("n.noOp()");
  });

  test("splitInBatches を for ループに復元する", () => {
    const workflow: N8nWorkflowInput = {
      name: "loop-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "splitInBatches_2", type: "n8n-nodes-base.splitInBatches", typeVersion: 3, parameters: {}, position: [200, 0] },
        { name: "noOp_3", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 0] },
        { name: "set_4", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "done" }, position: [400, 200] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "splitInBatches_2", type: "main", index: 0 }]] },
        splitInBatches_2: {
          main: [
            [{ node: "set_4", type: "main", index: 0 }],
            [{ node: "noOp_3", type: "main", index: 0 }],
          ],
        },
        noOp_3: { main: [[{ node: "splitInBatches_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (const _ of n.loop({}))");
    expect(result.code).toContain("n.noOp()");
    expect(result.code).toContain('n.set({ value: "done" })');
  });

  test("fan-out を n.parallel に復元する", () => {
    const workflow: N8nWorkflowInput = {
      name: "parallel-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "set_2", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "a" }, position: [200, 0] },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "b" }, position: [200, 200] },
      ],
      connections: {
        manualTrigger_1: {
          main: [[
            { node: "set_2", type: "main", index: 0 },
            { node: "set_3", type: "main", index: 0 },
          ]],
        },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("n.parallel(");
    expect(result.code).toContain('n.set({ value: "a" })');
    expect(result.code).toContain('n.set({ value: "b" })');
  });

  test("credentials 付きノードの options を保持する", () => {
    const workflow: N8nWorkflowInput = {
      name: "creds-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "my request",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com" },
          credentials: { httpBasicAuth: { id: "cred-1", name: "My Auth" } },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "my request", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Space-containing names use @name JSDoc instead of options.name
    expect(result.code).toContain("/** @name my request */");
    expect(result.code).toContain('"cred-1"');
  });

  test("未対応ノードタイプでエラーを返す", () => {
    const workflow: N8nWorkflowInput = {
      name: "unsupported",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "unknown_2", type: "n8n-nodes-base.unknownFoo", typeVersion: 1, parameters: {}, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "unknown_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.code).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Unsupported node type");
  });

  test("switch ノードを switch 文に復元する", () => {
    const workflow: N8nWorkflowInput = {
      name: "switch-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "switch_2", type: "n8n-nodes-base.switch", typeVersion: 3,
          parameters: {
            mode: "rules",
            value: '={{$node["req"].json.status}}',
            rules: {
              values: [
                { outputIndex: 0, operation: "equal", value: 200 },
                { outputIndex: 1, operation: "equal", value: 404 },
              ],
            },
            fallbackOutput: "extra",
          },
          position: [200, 0],
        },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "ok" }, position: [400, 0] },
        { name: "noOp_4", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 200] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "switch_2", type: "main", index: 0 }]] },
        switch_2: {
          main: [
            [{ node: "set_3", type: "main", index: 0 }],
            [{ node: "noOp_4", type: "main", index: 0 }],
          ],
        },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("switch (n.expr(");
    expect(result.code).toContain("case 200:");
    expect(result.code).toContain("case 404:");
  });

  test("scheduleTrigger のパラメータを DSL 形式に逆変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "schedule-test",
      nodes: [
        {
          name: "scheduleTrigger_1", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2,
          parameters: {
            rule: { interval: [{ field: "minutes", minutesInterval: 5 }] },
          },
          position: [0, 0],
        },
        { name: "noOp_2", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [200, 0] },
      ],
      connections: {
        scheduleTrigger_1: { main: [[{ node: "noOp_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("intervalMinutes: 5");
    expect(result.code).toContain('type: "minutes"');
  });
});

describe("ラウンドトリップ: generate → compile", () => {
  test("sequential ワークフローのラウンドトリップ", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-seq",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "done" }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();
    expect(compileResult.workflow!.name).toBe("roundtrip-seq");
    expect(compileResult.workflow!.nodes.map((n) => n.type)).toEqual([
      "n8n-nodes-base.manualTrigger",
      "n8n-nodes-base.httpRequest",
      "n8n-nodes-base.set",
    ]);
  });

  test("if/else ワークフローのラウンドトリップ", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-if",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "if_2", type: "n8n-nodes-base.if", typeVersion: 2,
          parameters: {
            conditions: {
              conditions: [{ leftValue: "={{$json.ok}}", rightValue: true, operator: { type: "boolean", operation: "true" } }],
              combinator: "and",
              options: {},
            },
            options: {},
          },
          position: [200, 0],
        },
        { name: "noOp_3", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 0] },
        { name: "noOp_4", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 200] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "if_2", type: "main", index: 0 }]] },
        if_2: {
          main: [
            [{ node: "noOp_3", type: "main", index: 0 }],
            [{ node: "noOp_4", type: "main", index: 0 }],
          ],
        },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();
    expect(compileResult.workflow!.name).toBe("roundtrip-if");

    // Should have: trigger, if, 2 noOps
    const nodeTypes = compileResult.workflow!.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("n8n-nodes-base.if");
    expect(nodeTypes.filter((t) => t === "n8n-nodes-base.noOp")).toHaveLength(2);
  });

  test("loop ワークフローのラウンドトリップ", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-loop",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "splitInBatches_2", type: "n8n-nodes-base.splitInBatches", typeVersion: 3, parameters: {}, position: [200, 0] },
        { name: "noOp_3", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [400, 0] },
        { name: "set_4", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "done" }, position: [400, 200] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "splitInBatches_2", type: "main", index: 0 }]] },
        splitInBatches_2: {
          main: [
            [{ node: "set_4", type: "main", index: 0 }],
            [{ node: "noOp_3", type: "main", index: 0 }],
          ],
        },
        noOp_3: { main: [[{ node: "splitInBatches_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const nodeTypes = compileResult.workflow!.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("n8n-nodes-base.splitInBatches");
  });

  test("@name JSDoc 付きノードのラウンドトリップ", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-jsdoc-name",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "my request",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com" },
          credentials: { httpBasicAuth: { id: "cred-1", name: "My Auth" } },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "my request", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).toContain("/** @name my request */");
    expect(genResult.code).not.toContain('name: "my request"');

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const httpNode = compileResult.workflow!.nodes[1];
    expect(httpNode?.name).toBe("my request");
    expect(httpNode?.credentials).toEqual({
      httpBasicAuth: { id: "cred-1", name: "My Auth" },
    });
  });
});

describe("生成改善", () => {
  test("空の settings は省略される", () => {
    const workflow: N8nWorkflowInput = {
      name: "empty-settings",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "noOp_2", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "noOp_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toContain("settings:");
  });

  test("非空の settings は出力される", () => {
    const workflow: N8nWorkflowInput = {
      name: "nonempty-settings",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "noOp_2", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "noOp_2", type: "main", index: 0 }]] },
      },
      settings: { timezone: "Asia/Tokyo" },
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("settings:");
    expect(result.code).toContain("Asia/Tokyo");
  });

  test("パラメータ内の空 options は削除される", () => {
    const workflow: N8nWorkflowInput = {
      name: "empty-options",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com", options: {} }, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Should not contain options: {} in the httpRequest call
    expect(result.code).not.toMatch(/options:\s*\{\s*\}/);
  });

  test("スペースを含むノード名は @name JSDoc で出力される", () => {
    const workflow: N8nWorkflowInput = {
      name: "space-name",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "work task",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "POST", url: "https://example.com" },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "work task", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("/** @name work task */");
    // name should NOT be in options
    expect(result.code).not.toContain('name: "work task"');
  });

  test("スペースなしのカスタム名は options.name で出力される", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-space-name",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "myRequest",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com" },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "myRequest", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toContain("/** @name");
    expect(result.code).toContain('name: "myRequest"');
  });
});
