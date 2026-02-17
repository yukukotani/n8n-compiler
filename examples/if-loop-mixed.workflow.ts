import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-if-loop-mixed",
  settings: {
    timezone: "Asia/Tokyo",
  },
  triggers: [n.manualTrigger()],
  execute() {
    const check = n.httpRequest({
      method: "GET",
      url: "https://swapi.dev/api/people/1",
    });

    if (check.height) {
      n.set({
        values: {
          branch: "run",
        },
      });

      for (const item of check.results) {
        const checkItem = n.httpRequest({
          method: "GET",
          url: "https://example.com/api/check-item",
        });

        if (checkItem.inner == true) {
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
