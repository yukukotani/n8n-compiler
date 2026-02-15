import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-if-else",
  settings: {
    timezone: "Asia/Tokyo",
  },
  execute() {
    n.manualTrigger();

    n.httpRequest({
      method: "GET",
      url: "https://example.com/api/check",
    });

    if (n.expr("={{$json.ok === true}}")) {
      n.set({
        values: {
          branch: "true",
        },
      });
    } else {
      n.noOp();
    }

    n.set({
      values: {
        done: true,
      },
    });
  },
});
