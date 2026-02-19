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
    // Each branch is an expression-body arrow returning the node call
    expect(result.code).toContain('() => n.set({ value: "a" })');
    expect(result.code).toContain('() => n.set({ value: "b" })');
  });

  test("fan-out → 合流ノード → 後続ノードを正しく復元する", () => {
    const workflow: N8nWorkflowInput = {
      name: "parallel-convergence",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "set_2", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "a" }, position: [200, 0] },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "b" }, position: [200, 200] },
        { name: "merge_4", type: "n8n-nodes-base.merge", typeVersion: 1, parameters: { mode: "append" }, position: [400, 100] },
        { name: "noOp_5", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [600, 100] },
      ],
      connections: {
        manualTrigger_1: {
          main: [[
            { node: "set_2", type: "main", index: 0 },
            { node: "set_3", type: "main", index: 0 },
          ]],
        },
        set_2: { main: [[{ node: "merge_4", type: "main", index: 0 }]] },
        set_3: { main: [[{ node: "merge_4", type: "main", index: 0 }]] },
        merge_4: { main: [[{ node: "noOp_5", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("n.parallel(");
    // merge and noOp should be OUTSIDE parallel, not inside a branch
    expect(result.code).toContain("n.merge(");
    expect(result.code).toContain("n.noOp()");

    // Roundtrip: compile back and verify all edges are present
    const compileResult = compile({ file: "parallel-convergence.ts", sourceText: result.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const connections = compileResult.workflow!.connections;
    // Both set nodes should connect to merge (node names may be auto-generated)
    const nodeNames = compileResult.workflow!.nodes.map((n) => n.name);
    const set2Name = nodeNames.find((n) => n.startsWith("set_") && n !== "set_3");
    const set3Name = nodeNames.find((n) => n === "set_3" || (n.startsWith("set_") && n !== set2Name));
    const mergeName = nodeNames.find((n) => n.startsWith("merge"));
    const noOpName = nodeNames.find((n) => n.startsWith("noOp"));

    expect(set2Name).toBeDefined();
    expect(mergeName).toBeDefined();
    expect(noOpName).toBeDefined();

    // set nodes connect to merge
    const set2Conn = connections[set2Name!]?.main?.[0];
    expect(set2Conn).toEqual(expect.arrayContaining([expect.objectContaining({ node: mergeName })]));
    // merge connects to noOp
    const mergeConn = connections[mergeName!]?.main?.[0];
    expect(mergeConn).toEqual(expect.arrayContaining([expect.objectContaining({ node: noOpName })]));
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

  test("DateTime + $ を含む式のラウンドトリップ (import → compile)", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-datetime",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "googleCalendar_2",
          type: "n8n-nodes-base.googleCalendar",
          typeVersion: 1.3,
          parameters: {
            start: "={{ DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 9 }) }}",
            end: "={{ DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 19 }) }}",
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "googleCalendar_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();
    // Generated code should have raw DateTime expressions
    expect(genResult.code).toContain("DateTime.fromISO(");

    const compileResult = compile({ file: "roundtrip-datetime.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    // The compiled result should have the expressions wrapped in ={{...}}
    const calNode = compileResult.workflow!.nodes[1];
    expect(calNode?.type).toBe("n8n-nodes-base.googleCalendar");
    // Note: single quotes in $('...') become double quotes after round-trip
    expect(calNode?.parameters.start).toBe('={{DateTime.fromISO($("My Trigger").item.json.start.dateTime).set({ hour: 9 })}}');
    expect(calNode?.parameters.end).toBe('={{DateTime.fromISO($("My Trigger").item.json.start.dateTime).set({ hour: 19 })}}');
  });

  test("重複 credentials のラウンドトリップ (const 切り出し → compile)", () => {
    const cred = { id: "cred-1", name: "My Auth" };
    const original: N8nWorkflowInput = {
      name: "roundtrip-dedup",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com/a" },
          credentials: { httpBasicAuth: cred },
          position: [200, 0],
        },
        {
          name: "httpRequest_3",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com/b" },
          credentials: { httpBasicAuth: cred },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "httpRequest_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).toContain("const httpBasicAuth");

    const compileResult = compile({ file: "roundtrip-dedup.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    // Both nodes should have the same credentials resolved from the const
    const node2 = compileResult.workflow!.nodes[1];
    const node3 = compileResult.workflow!.nodes[2];
    expect(node2?.credentials).toEqual({ httpBasicAuth: cred });
    expect(node3?.credentials).toEqual({ httpBasicAuth: cred });
  });
});

describe("非main接続 (AI sub-nodes)", () => {
  test("ai_languageModel 接続のノードを n.connect() で生成する", () => {
    const workflow: N8nWorkflowInput = {
      name: "ai-agent-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          parameters: { promptType: "define", text: "Hello" },
          position: [200, 0],
        },
        {
          name: "Gemini Model",
          type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
          typeVersion: 1,
          parameters: { projectId: "my-project", modelName: "gemini-2.0-flash" },
          credentials: { googleApi: { id: "cred-gcp", name: "GCP" } },
          position: [200, 200],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "AI Agent", type: "main", index: 0 }]] },
        "Gemini Model": { ai_languageModel: [[{ node: "AI Agent", type: "ai_languageModel", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should contain the agent call in main flow
    expect(result.code).toContain("n.langchainAgent(");
    // Should contain the model inside n.connect()
    expect(result.code).toContain("n.connect(");
    expect(result.code).toContain("n.lmChatGoogleVertex(");
    expect(result.code).toContain('"AI Agent"');
    expect(result.code).toContain('"ai_languageModel"');
    // Should contain model name
    expect(result.code).toContain('"Gemini Model"');
  });

  test("ai_languageModel 接続のラウンドトリップ (generate → compile)", () => {
    const workflow: N8nWorkflowInput = {
      name: "ai-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          parameters: { promptType: "define", text: "Hello" },
          position: [200, 0],
        },
        {
          name: "Gemini Model",
          type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
          typeVersion: 1,
          parameters: { projectId: "my-project", modelName: "gemini-2.0-flash" },
          credentials: { googleApi: { id: "cred-gcp", name: "GCP" } },
          position: [200, 200],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "AI Agent", type: "main", index: 0 }]] },
        "Gemini Model": { ai_languageModel: [[{ node: "AI Agent", type: "ai_languageModel", index: 0 }]] },
      },
      settings: {},
    };

    // import (n8n JSON → DSL code)
    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // compile (DSL code → n8n JSON)
    const compileResult = compile({ file: "ai-roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    // Should have all 3 nodes
    const nodeTypes = compileResult.workflow!.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("n8n-nodes-base.manualTrigger");
    expect(nodeTypes).toContain("@n8n/n8n-nodes-langchain.agent");
    expect(nodeTypes).toContain("@n8n/n8n-nodes-langchain.lmChatGoogleVertex");

    // Should have ai_languageModel connection
    const modelNode = compileResult.workflow!.nodes.find((n) => n.type === "@n8n/n8n-nodes-langchain.lmChatGoogleVertex");
    expect(modelNode).toBeDefined();
    const agentNode = compileResult.workflow!.nodes.find((n) => n.type === "@n8n/n8n-nodes-langchain.agent");
    expect(agentNode).toBeDefined();

    // Check ai_languageModel connection exists
    const modelConnections = compileResult.workflow!.connections[modelNode!.name];
    expect(modelConnections).toBeDefined();
    expect(modelConnections!.ai_languageModel).toBeDefined();
    expect(modelConnections!.ai_languageModel![0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: agentNode!.name, type: "ai_languageModel" }),
      ]),
    );

    // Model node should have credentials
    expect(modelNode!.credentials).toEqual({ googleApi: { id: "cred-gcp", name: "GCP" } });
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

  test("重複する credentials 値を const に切り出す", () => {
    const cred = { id: "cred-1", name: "My Auth" };
    const workflow: N8nWorkflowInput = {
      name: "dedup-creds",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com/a" },
          credentials: { httpBasicAuth: cred },
          position: [200, 0],
        },
        {
          name: "httpRequest_3",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com/b" },
          credentials: { httpBasicAuth: cred },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "httpRequest_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should have a const declaration
    expect(result.code).toContain('const httpBasicAuth = { id: "cred-1", name: "My Auth" };');
    // Should use shorthand in credentials (e.g. `credentials: { httpBasicAuth }`)
    expect(result.code).toContain("{ httpBasicAuth }");
    // Should NOT have the literal object inline in credentials
    expect(result.code).not.toMatch(/credentials:.*id:.*"cred-1"/);
  });

  test("1回しか出現しない credentials は const に切り出さない", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-dedup-creds",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com" },
          credentials: { httpBasicAuth: { id: "cred-1", name: "My Auth" } },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // No const declaration
    expect(result.code).not.toMatch(/^const /m);
    // Inline credential
    expect(result.code).toContain('"cred-1"');
  });

  test("重複するパラメータ値も汎用的に const に切り出す", () => {
    const sharedCalendar = { __rl: true, cachedResultName: "test@example.com", mode: "list", value: "test@example.com" };
    const workflow: N8nWorkflowInput = {
      name: "dedup-params",
      nodes: [
        {
          name: "googleCalendarTrigger_1",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: sharedCalendar, triggerOn: "eventCreated" },
          position: [0, 0],
        },
        {
          name: "googleCalendar_2",
          type: "n8n-nodes-base.googleCalendar",
          typeVersion: 1.3,
          parameters: { calendar: sharedCalendar, start: "2025-01-01", end: "2025-01-02" },
          position: [200, 0],
        },
      ],
      connections: {
        googleCalendarTrigger_1: { main: [[{ node: "googleCalendar_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // The calendarId/calendar values are different keys but same value.
    // Since key names differ, the first key encountered is used as const name.
    // Check that a const declaration exists
    expect(result.code).toMatch(/^const \w+ = \{/m);
  });

  test("空の options/additionalFields のみで共有される値は const に切り出さない", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-empty-consts",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com/a", options: {}, additionalFields: {} },
          position: [200, 0],
        },
        {
          name: "httpRequest_3",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: { method: "GET", url: "https://example.com/b", options: {}, additionalFields: {} },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "httpRequest_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // No const declaration for empty objects
    expect(result.code).not.toMatch(/^const /m);
    // options: {} and additionalFields: {} should not appear in output
    expect(result.code).not.toMatch(/options:\s*\{\s*\}/);
    expect(result.code).not.toContain("additionalFields");
  });

  test("jsonBody の ={...} 形式を JS object として import する", () => {
    const workflow: N8nWorkflowInput = {
      name: "jsonbody-import",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: {
            method: "POST",
            url: "https://example.com/api",
            sendBody: true,
            specifyBody: "json",
            jsonBody: '={ "foo": "bar", "count": 42 }',
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();
    // Should be a JS object literal, not a string
    expect(result.code).toContain("jsonBody: { foo: \"bar\", count: 42 }");
    // Should NOT contain the raw ={...} string
    expect(result.code).not.toContain('={ "foo"');
  });

  test("jsonBody の ={...} ラウンドトリップ（import → compile）", () => {
    const workflow: N8nWorkflowInput = {
      name: "jsonbody-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: {
            method: "POST",
            url: "https://example.com/api",
            sendBody: true,
            specifyBody: "json",
            jsonBody: '={ "foo": "bar" }',
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    // import (n8n JSON → DSL code)
    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // compile (DSL code → n8n JSON)
    const compileResult = compile({ file: "jsonbody-roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const httpNode = compileResult.workflow!.nodes[1];
    expect(httpNode?.parameters.jsonBody).toBe('={"foo":"bar"}');
  });

  test("={{ ... }} の compound expression (CallExpression) は raw JS として出力される", () => {
    const workflow: N8nWorkflowInput = {
      name: "unwrap-expr",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "googleCalendar_2",
          type: "n8n-nodes-base.googleCalendar",
          typeVersion: 1.3,
          parameters: {
            start: "={{ DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 9 }) }}",
            end: "={{ DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 19 }) }}",
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "googleCalendar_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should output raw expression without quotes
    expect(result.code).toContain("DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 9 })");
    expect(result.code).toContain("DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 19 })");
    // Should NOT have ={{ ... }} wrapper
    expect(result.code).not.toContain('"={{ DateTime');
    // Should import DateTime and $ from DSL
    expect(result.code).toContain("import { n, workflow, $, DateTime }");
  });

  test("={{ $json.field }} の simple expression は文字列のまま出力される", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-unwrap",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "set_2",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: { value: "={{$json.field}}" },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "set_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Should stay as a string (not unwrapped)
    expect(result.code).toContain('"={{$json.field}}"');
    // Should not import n8n globals since none are used as raw expressions
    expect(result.code).toContain("import { n, workflow }");
  });

  test("$('Trigger Name') をトリガーの execute パラメータ参照に変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "trigger-ref",
      nodes: [
        {
          name: "Google Calendar Trigger",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: "test@example.com", triggerOn: "eventCreated" },
          position: [0, 0],
        },
        {
          name: "googleCalendar_2",
          type: "n8n-nodes-base.googleCalendar",
          typeVersion: 1.3,
          parameters: {
            start: '={{ DateTime.fromISO($("Google Calendar Trigger").item.json.start.dateTime).set({ hour: 9 }) }}',
            end: '={{ DateTime.fromISO($("Google Calendar Trigger").item.json.start.dateTime).set({ hour: 19 }) }}',
          },
          position: [200, 0],
        },
      ],
      connections: {
        "Google Calendar Trigger": { main: [[{ node: "googleCalendar_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should have execute parameter
    expect(result.code).toContain("execute(googleCalendar)");
    // Should use param reference instead of $('...')
    expect(result.code).toContain("googleCalendar.start.dateTime");
    // Should NOT contain $('Google Calendar Trigger')
    expect(result.code).not.toContain("$('Google Calendar Trigger')");
    expect(result.code).not.toContain('$("Google Calendar Trigger")');
    // Should NOT import $ since all references were replaced
    expect(result.code).toContain("import { n, workflow, DateTime }");
    expect(result.code).not.toContain(", $ ");
    expect(result.code).not.toContain(", $,");
    // Should preserve trigger display name
    expect(result.code).toContain('name: "Google Calendar Trigger"');
  });

  test("$('Trigger Name') がシンプルな MemberExpression の場合も変換される", () => {
    const workflow: N8nWorkflowInput = {
      name: "simple-trigger-ref",
      nodes: [
        {
          name: "Google Calendar Trigger",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: "test@example.com", triggerOn: "eventCreated" },
          position: [0, 0],
        },
        {
          name: "set_2",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            value: '={{ $("Google Calendar Trigger").item.json.summary }}',
          },
          position: [200, 0],
        },
      ],
      connections: {
        "Google Calendar Trigger": { main: [[{ node: "set_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Simple member expression should be unwrapped
    expect(result.code).toContain("googleCalendar.summary");
    expect(result.code).toContain("execute(googleCalendar)");
  });

  test("$('Trigger Name') → execute パラメータ参照のラウンドトリップ", () => {
    const workflow: N8nWorkflowInput = {
      name: "trigger-ref-roundtrip",
      nodes: [
        {
          name: "Google Calendar Trigger",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: "test@example.com", triggerOn: "eventCreated" },
          position: [0, 0],
        },
        {
          name: "googleCalendar_2",
          type: "n8n-nodes-base.googleCalendar",
          typeVersion: 1.3,
          parameters: {
            start: '={{ DateTime.fromISO($("Google Calendar Trigger").item.json.start.dateTime).set({ hour: 9 }) }}',
            end: '={{ DateTime.fromISO($("Google Calendar Trigger").item.json.start.dateTime).set({ hour: 19 }) }}',
          },
          position: [200, 0],
        },
      ],
      connections: {
        "Google Calendar Trigger": { main: [[{ node: "googleCalendar_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    const compileResult = compile({ file: "roundtrip-trigger-ref.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    // Trigger should keep its display name
    expect(compileResult.workflow!.nodes[0]?.name).toBe("Google Calendar Trigger");

    // Calendar node should have expressions referencing the trigger by display name
    const calNode = compileResult.workflow!.nodes[1];
    expect(calNode?.type).toBe("n8n-nodes-base.googleCalendar");
    expect(calNode?.parameters.start).toBe(
      '={{DateTime.fromISO($node["Google Calendar Trigger"].json.start.dateTime).set({ hour: 9 })}}',
    );
    expect(calNode?.parameters.end).toBe(
      '={{DateTime.fromISO($node["Google Calendar Trigger"].json.start.dateTime).set({ hour: 19 })}}',
    );
  });

  test("非トリガーノードへの $('...') 参照は $ のまま維持される", () => {
    const workflow: N8nWorkflowInput = {
      name: "non-trigger-ref",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "googleCalendar_2",
          type: "n8n-nodes-base.googleCalendar",
          typeVersion: 1.3,
          parameters: {
            start: "={{ DateTime.fromISO($('My Trigger').item.json.start.dateTime).set({ hour: 9 }) }}",
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "googleCalendar_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Should keep $('My Trigger') since 'My Trigger' is not a trigger node name
    expect(result.code).toContain("$('My Trigger')");
    // Should import $
    expect(result.code).toContain("import { n, workflow, $, DateTime }");
    // Should NOT have execute params
    expect(result.code).toContain("execute()");
  });

  test("jsonBody 内の {{ expr }} をトリガー参照で raw 式に変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "jsonbody-mustache-trigger",
      nodes: [
        {
          name: "Google Calendar Trigger",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: "test@example.com", triggerOn: "eventCreated" },
          position: [0, 0],
        },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: {
            method: "POST",
            url: "https://example.com/api",
            sendBody: true,
            specifyBody: "json",
            jsonBody: `={ "start": { "dateTime": "{{ $('Google Calendar Trigger').item.json.start.dateTime }}" }, "end": { "dateTime": "{{ $('Google Calendar Trigger').item.json.end.dateTime }}" } }`,
          },
          position: [200, 0],
        },
      ],
      connections: {
        "Google Calendar Trigger": { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should have execute parameter for the trigger
    expect(result.code).toContain("execute(googleCalendar)");
    // Should use raw trigger references instead of mustache expressions
    expect(result.code).toContain("googleCalendar.start.dateTime");
    expect(result.code).toContain("googleCalendar.end.dateTime");
    // Should NOT contain {{ expr }} strings
    expect(result.code).not.toContain("{{ $(");
    expect(result.code).not.toContain("{{$(");
  });

  test("jsonBody 内の {{ expr }} を一般式でも raw 式に変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "jsonbody-mustache-general",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: {
            method: "POST",
            url: "https://example.com/api",
            sendBody: true,
            specifyBody: "json",
            jsonBody: '={ "requestId": "{{Math.floor(Math.random()*999999999)}}" }',
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should use raw expression
    expect(result.code).toContain("Math.floor(Math.random()*999999999)");
    // Should NOT contain {{ }} wrapper
    expect(result.code).not.toContain("{{Math.floor");
  });

  test("jsonBody 内の {{ expr }} ラウンドトリップ (トリガー参照)", () => {
    const workflow: N8nWorkflowInput = {
      name: "jsonbody-mustache-roundtrip",
      nodes: [
        {
          name: "Google Calendar Trigger",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: "test@example.com", triggerOn: "eventCreated" },
          position: [0, 0],
        },
        {
          name: "httpRequest_2",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          parameters: {
            method: "POST",
            url: "https://example.com/api",
            sendBody: true,
            specifyBody: "json",
            jsonBody: `={ "dateTime": "{{ $('Google Calendar Trigger').item.json.start.dateTime }}" }`,
          },
          position: [200, 0],
        },
      ],
      connections: {
        "Google Calendar Trigger": { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    // import (n8n JSON → DSL code)
    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();
    expect(genResult.code).toContain("googleCalendar.start.dateTime");

    // compile (DSL code → n8n JSON)
    const compileResult = compile({ file: "jsonbody-mustache-roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const httpNode = compileResult.workflow!.nodes[1];
    // jsonBody should contain the trigger reference in n8n mustache format
    expect(httpNode?.parameters.jsonBody).toContain("$('Google Calendar Trigger').item.json.start.dateTime");
    expect(httpNode?.parameters.jsonBody).toMatch(/^\=/);
  });

  test("実質空の options (全値が空文字) は削除される", () => {
    const workflow: N8nWorkflowInput = {
      name: "empty-options-values",
      nodes: [
        {
          name: "googleCalendarTrigger_1",
          type: "n8n-nodes-base.googleCalendarTrigger",
          typeVersion: 1,
          parameters: { calendarId: "test@example.com", triggerOn: "eventCreated", options: { matchTerm: "" } },
          position: [0, 0],
        },
        { name: "noOp_2", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [200, 0] },
      ],
      connections: {
        googleCalendarTrigger_1: { main: [[{ node: "noOp_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();
    // options with only empty-string values should be stripped
    expect(result.code).not.toContain("matchTerm");
    expect(result.code).not.toMatch(/options:\s*\{/);
  });

  test("parameters が undefined のノードでもクラッシュせず生成できる", () => {
    const workflow: N8nWorkflowInput = {
      name: "missing-params",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
        { name: "noOp_2", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [200, 0] },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "ok" }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "noOp_2", type: "main", index: 0 }]] },
        noOp_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("n.manualTrigger()");
    expect(result.code).toContain("n.noOp()");
    expect(result.code).toContain('n.set({ value: "ok" })');
  });

  test("connections が undefined でもクラッシュせず生成できる", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-connections",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
      ],
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("n.manualTrigger()");
  });

  test("googleSheets の typeVersion がラウンドトリップで保持される", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-sheets-version",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "評価軸取得",
          type: "n8n-nodes-base.googleSheets",
          typeVersion: 4.5,
          parameters: {
            authentication: "serviceAccount",
            documentId: { __rl: true, mode: "url", value: "https://docs.google.com/spreadsheets/d/abc123" },
            sheetName: { __rl: true, mode: "id", value: "0" },
          },
          credentials: { googleApi: { id: "cred-1", name: "My Cred" } },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "評価軸取得", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // typeVersion 4.5 is the compiler default for googleSheets, so it should NOT appear in options
    expect(genResult.code).not.toContain("typeVersion");

    const compileResult = compile({ file: "roundtrip-sheets.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const sheetsNode = compileResult.workflow!.nodes[1];
    expect(sheetsNode?.type).toBe("n8n-nodes-base.googleSheets");
    expect(sheetsNode?.typeVersion).toBe(4.5);
  });

  test("非デフォルト typeVersion が import → compile でラウンドトリップする", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-sheets-custom-version",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "googleSheets_2",
          type: "n8n-nodes-base.googleSheets",
          typeVersion: 4.7,
          parameters: {
            authentication: "serviceAccount",
            documentId: { __rl: true, mode: "url", value: "https://docs.google.com/spreadsheets/d/abc123" },
            sheetName: { __rl: true, mode: "id", value: "0" },
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "googleSheets_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // typeVersion 4.7 differs from default 4.5, so it should appear in options
    expect(genResult.code).toContain("typeVersion: 4.7");

    const compileResult = compile({ file: "roundtrip-sheets-custom.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const sheetsNode = compileResult.workflow!.nodes[1];
    expect(sheetsNode?.type).toBe("n8n-nodes-base.googleSheets");
    expect(sheetsNode?.typeVersion).toBe(4.7);
  });

  test("非トリガーノードへの $('Node') 参照を const 変数参照に変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "node-ref-test",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "set_3",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            value: '={{ $("httpRequest_2").item.json.data }}',
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Referenced node should be output as const
    expect(result.code).toContain("const httpRequest = n.httpRequest(");
    // Reference should be replaced with variable access
    expect(result.code).toContain("httpRequest.data");
    // Should NOT contain $('httpRequest_2')
    expect(result.code).not.toContain("$('httpRequest_2')");
    expect(result.code).not.toContain('$("httpRequest_2")');
    // Should NOT import $ since all references were replaced
    expect(result.code).not.toContain(", $");
  });

  test("非トリガーノードの .first().json 参照も const 変数参照に変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "node-ref-first",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "set_3",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            value: '={{ $("httpRequest_2").first().json.result }}',
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    expect(result.code).toContain("const httpRequest = n.httpRequest(");
    expect(result.code).toContain("httpRequest.result");
  });

  test("スペースを含むノード名への $() 参照を const + @name で変換する", () => {
    const workflow: N8nWorkflowInput = {
      name: "node-ref-space-name",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "My Request", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "set_3",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            value: "={{ $('My Request').item.json.data }}",
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "My Request", type: "main", index: 0 }]] },
        "My Request": { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should have @name JSDoc and const
    expect(result.code).toContain("/** @name My Request */");
    expect(result.code).toContain("const httpRequest = n.httpRequest(");
    // Reference should use variable
    expect(result.code).toContain("httpRequest.data");
    // Should NOT contain the $ reference
    expect(result.code).not.toContain("$('My Request')");
  });

  test("非トリガーノード参照のラウンドトリップ (import → compile)", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-node-ref",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "set_3",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            value: '={{ $("httpRequest_2").item.json.result }}',
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    // import (n8n JSON → DSL code)
    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();
    expect(genResult.code).toContain("const httpRequest = n.httpRequest(");
    expect(genResult.code).toContain("httpRequest.result");

    // compile (DSL code → n8n JSON)
    const compileResult = compile({ file: "roundtrip-node-ref.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    // Set node should reference the httpRequest node
    const setNode = compileResult.workflow!.nodes[2];
    expect(setNode?.type).toBe("n8n-nodes-base.set");
    expect(setNode?.parameters.value).toContain("$node");
    expect(setNode?.parameters.value).toContain(".json.result");
  });

  test("参照されていないノードは const にならない", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-ref",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        { name: "set_3", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "hello" }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // No const should be generated since no node is referenced
    expect(result.code).not.toContain("const ");
  });

  test("同じ dslKind の複数ノードが参照される場合、変数名が重複しない", () => {
    const workflow: N8nWorkflowInput = {
      name: "dedup-varnames",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "code_2", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode: "return [{ json: { a: 1 } }];" }, position: [200, 0] },
        { name: "code_3", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode: "return [{ json: { b: 2 } }];" }, position: [200, 200] },
        {
          name: "set_4",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            value: '={{ $("code_2").item.json.a + $("code_3").item.json.b }}',
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: {
          main: [[
            { node: "code_2", type: "main", index: 0 },
            { node: "code_3", type: "main", index: 0 },
          ]],
        },
        code_2: { main: [[{ node: "set_4", type: "main", index: 0 }]] },
        code_3: { main: [[{ node: "set_4", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Both code nodes should be in destructuring with different names
    expect(result.code).toContain("const [code, code2] = n.parallel(");
    // References should use the variable names
    expect(result.code).toContain("code.a");
    expect(result.code).toContain("code2.b");
  });

  test("mixed template 内の $('Node') 参照は const 化される", () => {
    const workflow: N8nWorkflowInput = {
      name: "const-for-mixed-template-refs",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "langchainAgent_3",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          parameters: {
            // Mixed template text containing $('httpRequest_2') — converted to ${} interpolation
            text: "=<!-- Summary -->\nResult: {{ $('httpRequest_2').item.json.data }}\nEnd.",
            promptType: "define",
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "langchainAgent_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // httpRequest_2 is referenced inside a mixed template expression,
    // so it SHOULD become a const variable
    expect(result.code).toContain("const httpRequest = n.httpRequest(");
    // The reference should be replaced with the variable name
    expect(result.code).toContain("${httpRequest.data}");
    // Should NOT contain the original $('httpRequest_2') reference
    expect(result.code).not.toContain("$('httpRequest_2')");
    // Leading '=' should be stripped
    expect(result.code).not.toContain("text: `=");
  });

  test("$json を含む ={{...}} 式内の $('Node') 参照は const 化しない", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-const-for-n8n-globals",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "set_3",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          parameters: {
            // Expression contains $json (n8n-only global) so it won't be unwrapped
            value: "={{ $('httpRequest_2').item.json.x + $json.y }}",
          },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "set_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // The expression contains $json so it can't be unwrapped — no const should be generated
    expect(result.code).not.toContain("const httpRequest");
  });

  test("v1 (旧形式) googleSheets の typeVersion もラウンドトリップする", () => {
    const original: N8nWorkflowInput = {
      name: "roundtrip-sheets-v1",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "googleSheets_2",
          type: "n8n-nodes-base.googleSheets",
          typeVersion: 1,
          parameters: {
            sheetId: "abc123",
            range: "A:F",
            rawData: true,
          },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "googleSheets_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(original);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // typeVersion 1 differs from default 4.5, so it should appear in options
    expect(genResult.code).toContain("typeVersion: 1");

    const compileResult = compile({ file: "roundtrip-sheets-v1.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const sheetsNode = compileResult.workflow!.nodes[1];
    expect(sheetsNode?.type).toBe("n8n-nodes-base.googleSheets");
     expect(sheetsNode?.typeVersion).toBe(1);
  });

  test("複数行の jsCode は arrow function で出力される", () => {
    const jsCode = `// Node: test
const result = $input.first().json;
return {
  "hasRecord": result.exists === true,
  "content": result.content || null
};
`;
    const workflow: N8nWorkflowInput = {
      name: "arrow-function-jsCode",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "code_2", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "code_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Should use arrow function, not template literal or JSON string
    expect(result.code).toContain("jsCode: () => {");
    expect(result.code).not.toContain("jsCode: `");
    expect(result.code).not.toContain('jsCode: "');
    // Should contain actual newlines inside the function body
    expect(result.code).toContain("// Node: test\n");
  });

  test("jsCode に ${} を含む複数行文字列が arrow function 内でそのまま出力される", () => {
    const jsCode = `const formatDate = (date) => {
  const year = date.getFullYear();
  return \`\${year}-\${String(date.getMonth() + 1).padStart(2, '0')}\`;
};
return formatDate(new Date());
`;
    const workflow: N8nWorkflowInput = {
      name: "arrow-function-no-escape",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "code_2", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "code_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Should use arrow function
    expect(result.code).toContain("jsCode: () => {");
    // ${} inside function body needs no escaping (it's regular TS code)
    expect(result.code).toContain("${year}");
    expect(result.code).toContain("${String(date.getMonth()");
    // Should NOT have backslash-escaped ${}
    expect(result.code).not.toContain("\\${year}");
  });

  test("jsCode arrow function のラウンドトリップ (generate → compile)", () => {
    const jsCode = `// Node: 当該Qの計算
const formatDate = (date) => {
  const year = date.getFullYear();
  return \`\${year}-\${String(date.getMonth() + 1).padStart(2, '0')}\`;
};
return formatDate(new Date());
`;
    const workflow: N8nWorkflowInput = {
      name: "arrow-function-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "code_2", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "code_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const codeNode = compileResult.workflow!.nodes[1];
    expect(codeNode?.type).toBe("n8n-nodes-base.code");
    expect(codeNode?.parameters.jsCode).toBe(jsCode);
  });

  test("langchainAgent の text/systemMessage テンプレートリテラルのラウンドトリップ", () => {
    const text = "=<!-- Node: AI -->\n\n与えられた情報:\n<name>\n{{ $('Node1').item.json.name }}\n</name>\n";
    const systemMessage = "あなたは専門家です。\n\n# 入力情報\n\n- 対象：[入力]\n\n# ルール\n\n1. 項目を抽出\n2. 具体的に記述\n";

    const workflow: N8nWorkflowInput = {
      name: "langchain-template-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "Node1", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        {
          name: "langchainAgent_2",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          parameters: { promptType: "define", text, options: { systemMessage } },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "Node1", type: "main", index: 0 }]] },
        Node1: { main: [[{ node: "langchainAgent_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    // text should use template literal with ${} interpolation (mixed template converted)
    expect(genResult.code).toContain("text: `");
    // systemMessage has no expressions, should use plain template literal
    expect(genResult.code).toContain("systemMessage: `");
    // text should have ${} interpolation instead of {{ }}
    expect(genResult.code).toContain("${httpRequest.name}");
    expect(genResult.code).not.toContain("{{ $('Node1')");

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const agentNode = compileResult.workflow!.nodes[2];
    // Compiled text uses mixed template format: =text{{ expr }}text
    expect(agentNode?.parameters.text).toContain("$node[");
    expect(agentNode?.parameters.text).toContain(".json.name");
    // systemMessage stays as-is (no expressions)
    expect((agentNode?.parameters.options as any)?.systemMessage).toBe(systemMessage);
  });

  test("バッククォートを含む複数行文字列のラウンドトリップ (arrow function)", () => {
    const jsCode = "const msg = `Hello ${name}`;\nreturn [{ json: { msg } }];\n";

    const workflow: N8nWorkflowInput = {
      name: "backtick-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "code_2", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "code_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    // Arrow function body contains backticks as regular TS code
    expect(genResult.code).toContain("jsCode: () => {");

    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const codeNode = compileResult.workflow!.nodes[1];
    expect(codeNode?.parameters.jsCode).toBe(jsCode);
  });

  test("mixed template のラウンドトリップ (複雑な式 + arrow function)", () => {
    const text = "=<name>\n{{ $('Node1').item.json.name }}\n</name>\n<items>\n{{ $('Node2').all().filter(i => i.json.ok).map(i => `[${i.json.date}] ${i.json.text}`).join('\\n') }}\n</items>\n";
    const workflow: N8nWorkflowInput = {
      name: "mixed-template-complex-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "Node1", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com/1" }, position: [200, 0] },
        { name: "Node2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com/2" }, position: [200, 200] },
        {
          name: "langchainAgent_4",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          parameters: { promptType: "define", text },
          position: [400, 0],
        },
      ],
      connections: {
        manualTrigger_1: {
          main: [[
            { node: "Node1", type: "main", index: 0 },
            { node: "Node2", type: "main", index: 0 },
          ]],
        },
        Node1: { main: [[{ node: "langchainAgent_4", type: "main", index: 0 }]] },
        Node2: { main: [[{ node: "langchainAgent_4", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    // import (n8n JSON → DSL code)
    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // Parallel branches: Node1 and Node2 are in separate branches
    expect(genResult.code).toContain("const [httpRequest, httpRequest2] = n.parallel(");
    expect(genResult.code).toContain("${httpRequest.name}");

    // Node2 referenced via .all() → $() call is preserved
    // $ should be imported for the $() call
    expect(genResult.code).toContain("import { n, workflow, $ }");
    expect(genResult.code).toContain("$('Node2').all()");

    // No leading '=' in the template
    expect(genResult.code).not.toContain("text: `=");

    // compile (DSL code → n8n JSON)
    const compileResult = compile({ file: "mixed-template-roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const agentNode = compileResult.workflow!.nodes.find(n => n.type === "@n8n/n8n-nodes-langchain.agent");
    const compiledText = agentNode?.parameters.text as string;
    // Should use mixed template format: =text{{ expr }}text
    expect(compiledText).toMatch(/^=<name>/);
    // Should contain the node reference
    expect(compiledText).toContain('$node["Node1"].json.name');
    // Should contain the .all().filter() chain with arrow functions
    expect(compiledText).toContain('$("Node2").all().filter(');
    expect(compiledText).toContain("=> ");
  });

  test("$json を含む mixed template は変換されない", () => {
    const text = "=text: {{ $json.field }}\nend";
    const workflow: N8nWorkflowInput = {
      name: "mixed-template-n8n-globals",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        {
          name: "langchainAgent_2",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          parameters: { promptType: "define", text },
          position: [200, 0],
        },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "langchainAgent_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // Should stay as plain template literal (not converted because of $json)
    expect(result.code).toContain("{{ $json.field }}");
    expect(result.code).toContain("text: `=");
  });

  test("単一行文字列はテンプレートリテラルにしない", () => {
    const workflow: N8nWorkflowInput = {
      name: "no-template-for-short",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "set_2", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "hello world" }, position: [200, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "set_2", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    // Single-line strings should stay as JSON strings
    expect(result.code).toContain('"hello world"');
    expect(result.code).not.toContain('`hello world`');
  });

  test("jsCode 内の $input.first().json が前ノードの const 参照に変換される", () => {
    const jsCode = `const result = $input.first().json;
return {
  "hasRecord": result.exists === true,
  "content": result.content || null
};
`;
    const workflow: N8nWorkflowInput = {
      name: "code-input-ref",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        { name: "code_3", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "code_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // httpRequest should become a const (referenced by code node)
    expect(result.code).toContain("const httpRequest = n.httpRequest(");
    // $input.first().json should be replaced with httpRequest
    expect(result.code).toContain("const result = httpRequest;");
    // Should NOT contain $input.first().json
    expect(result.code).not.toContain("$input.first().json");
  });

  test("jsCode 内の $input.item.json も前ノードの const 参照に変換される", () => {
    const jsCode = "return { json: $input.item.json };";
    const workflow: N8nWorkflowInput = {
      name: "code-input-item-ref",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "set_2", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "test" }, position: [200, 0] },
        { name: "code_3", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode, mode: "runOnceForEachItem" }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "set_2", type: "main", index: 0 }]] },
        set_2: { main: [[{ node: "code_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // set should become a const
    expect(result.code).toContain("const set = n.set(");
    // $input.item.json should be replaced with set
    expect(result.code).toContain("return { json: set };");
  });

  test("jsCode $input → const のラウンドトリップ (generate → compile)", () => {
    const jsCode = `const result = $input.first().json;
return {
  "hasRecord": result.exists === true,
  "content": result.content || null
};
`;
    const workflow: N8nWorkflowInput = {
      name: "code-input-roundtrip",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://example.com" }, position: [200, 0] },
        { name: "code_3", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [400, 0] },
      ],
      connections: {
        manualTrigger_1: { main: [[{ node: "httpRequest_2", type: "main", index: 0 }]] },
        httpRequest_2: { main: [[{ node: "code_3", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    // import (n8n JSON → DSL code)
    const genResult = generateWorkflowCode(workflow);
    expect(genResult.errors).toEqual([]);
    expect(genResult.code).not.toBeNull();

    // compile (DSL code → n8n JSON)
    const compileResult = compile({ file: "roundtrip.ts", sourceText: genResult.code! });
    expect(compileResult.diagnostics).toEqual([]);
    expect(compileResult.workflow).not.toBeNull();

    const codeNode = compileResult.workflow!.nodes.find(n => n.type === "n8n-nodes-base.code");
    expect(codeNode).toBeDefined();
    // jsCode should be restored to use $input.first().json
    expect(codeNode!.parameters.jsCode).toBe(jsCode);
  });

  test("前ノードがない（複数 predecessor）場合は $input を変換しない", () => {
    const jsCode = "return $input.first().json;";
    const workflow: N8nWorkflowInput = {
      name: "code-input-multi-pred",
      nodes: [
        { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
        { name: "httpRequest_A", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://a.com" }, position: [200, 0] },
        { name: "httpRequest_B", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { method: "GET", url: "https://b.com" }, position: [200, 200] },
        { name: "code_4", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode }, position: [400, 100] },
      ],
      connections: {
        manualTrigger_1: { main: [[
          { node: "httpRequest_A", type: "main", index: 0 },
          { node: "httpRequest_B", type: "main", index: 0 },
        ]] },
        httpRequest_A: { main: [[{ node: "code_4", type: "main", index: 0 }]] },
        httpRequest_B: { main: [[{ node: "code_4", type: "main", index: 0 }]] },
      },
      settings: {},
    };

    const result = generateWorkflowCode(workflow);
    expect(result.errors).toEqual([]);
    expect(result.code).not.toBeNull();

    // $input should NOT be replaced (multiple predecessors → ambiguous)
    expect(result.code).toContain("$input.first().json");
  });
});
