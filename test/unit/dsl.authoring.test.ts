import { expect, test } from "bun:test";
import {
  n,
  workflow,
  type LoopOptions,
  type WorkflowDefinition,
} from "../../src/dsl";

test("Authoring API の型利用サンプル（workflow / n.expr / n.loop）", () => {
  const options: LoopOptions = { batchSize: 1, reset: false };
  const loopSource: Iterable<unknown> = n.loop(options);

  expect([...loopSource]).toEqual([]);

  const definition = workflow({
    name: "sample",
    settings: {
      timezone: "Asia/Tokyo",
    },
    triggers: [n.manualTrigger()],
    execute() {
      if (n.expr("={{$json.ok === true}}")) {
        n.set({
          assignments: {
            assignments: [{ name: "status", value: "ok", type: "string" }],
          },
        });
      }

      for (const _ of n.loop({ batchSize: 1 })) {
        n.httpRequest({ method: "GET", url: "={{$json.nextUrl}}" });
      }
    },
  }) satisfies WorkflowDefinition;

  expect(definition.name).toBe("sample");
});

test("NodeRef は前ノード結果のプロパティアクセスを型エラーなしで書ける", () => {
  const res = n.httpRequest({ method: "GET", url: "https://example.com" });

  // res.data はランタイムでは undefined（コンパイラは静的解析のみ）
  expect(res.data).toBeUndefined();

  // ネストしたプロパティアクセス・インデックスアクセスが型エラーにならないこと
  void res.body;
  void res[0];
  void res["content-type"];

  // パラメータ値として渡せること
  const definition = workflow({
    name: "node-ref-access",
    triggers: [n.manualTrigger()],
    execute() {
      const req = n.httpRequest({ method: "GET", url: "https://example.com" });
      n.set({ values: { data: req.data, status: req.headers.status } });
    },
  }) satisfies WorkflowDefinition;

  expect(definition.name).toBe("node-ref-access");
});
