export default workflow({
  name: "if-for-mixed",
  triggers: [n.manualTrigger()],
  execute() {
    if (n.expr("={{$json.runOuter}}")) {
      n.set({ scope: "outer-true" });

      for (const row of n.loop({ batchSize: 1 })) {
        if (n.expr("={{$json.innerOk}}")) {
          n.noOp();
        } else {
          n.set({ scope: "inner-false" });
        }
      }
    } else {
      n.noOp();
    }

    n.set({ scope: "completed" });
  },
});
