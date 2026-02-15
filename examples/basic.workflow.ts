import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-basic",
  settings: {
    timezone: "Asia/Tokyo",
  },
  triggers: [n.manualTrigger()],
  execute() {
    const res = n.httpRequest({
      method: "GET",
      url: "https://example.com/api/status",
    });

    n.set({
      values: {
        status: res.data.status,
        code: res.statusCode,
      },
    });
  },
});
