import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-basic",
  settings: {
    timezone: "Asia/Tokyo",
  },
  triggers: [
    n.manualTrigger(),
    n.scheduleTrigger({
      schedules: [
        {
          type: "days",
          intervalDays: 1,
          atHour: 18,
          atMinute: 4,
        },
      ],
    }),
  ],
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
