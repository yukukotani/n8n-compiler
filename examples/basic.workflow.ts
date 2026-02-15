import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-basic",
  settings: {
    timezone: "Asia/Tokyo",
  },
  execute() {
    n.manualTrigger();

    n.httpRequest({
      method: "GET",
      url: "https://example.com/api/status",
    });

    n.set({
      values: {
        status: "ok",
      },
    });
  },
});
