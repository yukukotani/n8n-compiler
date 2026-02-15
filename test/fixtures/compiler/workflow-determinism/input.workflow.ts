export default workflow({
  name: "workflow-determinism",
  settings: {
    timezone: "Asia/Tokyo",
    saveExecutionProgress: true,
  },
  triggers: [n.manualTrigger()],
  execute() {
    if (n.expr("={{$json.ok}}")) {
      n.noOp();
    } else {
      n.set({ value: "fallback" });
    }

    for (const item of n.loop({ batchSize: 2 })) {
      n.httpRequest({ method: "GET", url: "https://example.com" });
    }

    n.set({ value: "done" });
  },
});
