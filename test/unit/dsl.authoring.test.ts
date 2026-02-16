import { expect, test } from "bun:test";
import {
  n,
  workflow,
  type LoopOptions,
  type Schedule,
  type ScheduleTriggerParams,
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

test("ScheduleTriggerParams で型付きスケジュールトリガーを定義できる", () => {
  // minutes schedule
  const minutesParams: ScheduleTriggerParams = {
    schedules: [{ type: "minutes", intervalMinutes: 5 }],
  };
  const minutesTrigger = n.scheduleTrigger(minutesParams);
  expect(minutesTrigger.__brand).toBe("NodeRef");
  expect(minutesTrigger.kind).toBe("scheduleTrigger");
  expect(minutesTrigger.params).toEqual(minutesParams);

  // weeks schedule
  const weeksParams: ScheduleTriggerParams = {
    schedules: [
      {
        type: "weeks",
        intervalWeeks: 1,
        onWeekdays: ["monday"],
        atHour: 9,
        atMinute: 0,
      },
    ],
  };

  // cron schedule
  const cronParams: ScheduleTriggerParams = {
    schedules: [{ type: "cron", expression: "*/5 * * * *" }],
  };

  // workflow definition with scheduleTrigger
  const definition = workflow({
    name: "scheduled-workflow",
    triggers: [n.scheduleTrigger(cronParams)],
    execute() {
      n.noOp();
    },
  }) satisfies WorkflowDefinition;

  expect(definition.name).toBe("scheduled-workflow");
});

test("Schedule 型は type ごとに discriminated union として機能する", () => {
  // 各 type で型安全にスケジュールを定義できることを確認
  const seconds: Schedule = { type: "seconds", intervalSeconds: 30 };
  const minutes: Schedule = { type: "minutes", intervalMinutes: 5 };
  const hours: Schedule = { type: "hours", intervalHours: 2, atMinute: 15 };
  const days: Schedule = { type: "days", intervalDays: 2, atHour: 9, atMinute: 30 };
  const weeks: Schedule = {
    type: "weeks",
    intervalWeeks: 1,
    onWeekdays: ["monday", "friday"],
    atHour: 8,
    atMinute: 0,
  };
  const months: Schedule = {
    type: "months",
    intervalMonths: 3,
    atDayOfMonth: 15,
    atHour: 10,
    atMinute: 0,
  };
  const cron: Schedule = { type: "cron", expression: "0 9 * * 1-5" };

  const params: ScheduleTriggerParams = {
    schedules: [seconds, minutes, hours, days, weeks, months, cron],
  };

  const trigger = n.scheduleTrigger(params);
  expect(trigger.params.schedules).toHaveLength(7);
});

test("respondToWebhook を ActionNode として定義できる", () => {
  const node = n.respondToWebhook({ respondWith: "json", responseBody: "={{$json}}" });

  expect(node.__brand).toBe("NodeRef");
  expect(node.kind).toBe("respondToWebhook");
  expect(node.params).toEqual({ respondWith: "json", responseBody: "={{$json}}" });

  const definition = workflow({
    name: "respond-to-webhook-workflow",
    triggers: [n.manualTrigger()],
    execute() {
      n.respondToWebhook({ respondWith: "json", responseBody: "={{$json}}" });
    },
  }) satisfies WorkflowDefinition;

  expect(definition.name).toBe("respond-to-webhook-workflow");
});

test("switch を ActionNode として定義できる", () => {
  const node = n.switch({ expression: "={{$json.kind}}", cases: [{ value: "ok" }] });

  expect(node.__brand).toBe("NodeRef");
  expect(node.kind).toBe("switch");
  expect(node.params).toEqual({ expression: "={{$json.kind}}", cases: [{ value: "ok" }] });

  const definition = workflow({
    name: "switch-workflow",
    triggers: [n.manualTrigger()],
    execute() {
      n.switch({ expression: "={{$json.kind}}", cases: [{ value: "ok" }] });
    },
  }) satisfies WorkflowDefinition;

  expect(definition.name).toBe("switch-workflow");
});

test("webhookTrigger を TriggerNode として定義できる", () => {
  const trigger = n.webhookTrigger({ path: "incoming", httpMethod: "POST" });

  expect(trigger.__brand).toBe("NodeRef");
  expect(trigger.kind).toBe("webhookTrigger");
  expect(trigger.params).toEqual({ path: "incoming", httpMethod: "POST" });

  const definition = workflow({
    name: "webhook-workflow",
    triggers: [trigger],
    execute() {
      n.noOp();
    },
  }) satisfies WorkflowDefinition;

  expect(definition.name).toBe("webhook-workflow");
});
