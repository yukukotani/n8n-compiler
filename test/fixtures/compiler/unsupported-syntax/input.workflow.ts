export default workflow({
  name: "unsupported-syntax",
  execute() {
    n.manualTrigger();

    return;

    if (ok) {
      n.noOp();
    }

    for (item of n.loop({ batchSize: 1 })) {
      n.noOp();
    }

    for (const item of items) {
      n.noOp();
    }

    n.unknownNode({});
  },
});
