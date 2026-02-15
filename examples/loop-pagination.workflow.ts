import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-loop-pagination",
  settings: {
    timezone: "Asia/Tokyo",
  },
  execute() {
    n.manualTrigger();

    n.httpRequest({
      method: "GET",
      url: "https://example.com/api/page/1",
    });

    for (const page of n.loop({ batchSize: 1 })) {
      n.httpRequest({
        method: "GET",
        url: "={{$json.nextUrl}}",
      });

      n.set({
        values: {
          page,
        },
      });
    }

    n.set({
      values: {
        finished: true,
      },
    });
  },
});
