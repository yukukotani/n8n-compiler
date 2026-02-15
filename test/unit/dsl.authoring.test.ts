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
    execute() {
      n.manualTrigger();

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
