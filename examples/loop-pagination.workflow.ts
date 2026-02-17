import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-loop-pagination",
  settings: {
    timezone: "Asia/Tokyo",
  },
  triggers: [n.manualTrigger()],
  execute() {
    const firstPage = n.httpRequest({
      method: "GET",
      url: "https://example.com/api/page/1",
    });

    for (const page of firstPage.data.pages) {
      n.httpRequest({
        method: "GET",
        url: "={{$json.nextUrl}}",
      });

      n.set({
        values: {
          total: firstPage.data.totalPages,
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
