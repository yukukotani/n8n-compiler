import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-if-loop-mixed",
  settings: {
    timezone: "Asia/Tokyo",
  },
  execute() {
    n.manualTrigger();

    if (n.expr("={{$json.run === true}}")) {
      n.set({
        values: {
          branch: "run",
        },
      });

      for (const item of n.loop({ batchSize: 1 })) {
        if (n.expr("={{$json.inner === true}}")) {
          const result = n.httpRequest({
            method: "POST",
            url: "https://example.com/api/process",
          });

          n.set({
            values: {
              processedId: result.data.id,
            },
          });
        } else {
          n.noOp();
        }
      }
    } else {
      n.noOp();
    }

    n.set({
      values: {
        completed: true,
      },
    });
  },
});
