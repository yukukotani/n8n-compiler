import { n, workflow } from "../src/dsl";

export default workflow({
  name: "example-webhook-trigger-ref",
  settings: {
    timezone: "Asia/Tokyo",
  },
  triggers: [
    n.webhookTrigger({
      path: "incoming",
      httpMethod: "POST",
      responseMode: "lastNode",
    }),
  ],
  execute(webhook) {
    if (webhook.body.action === "ping") {
      n.respondToWebhook({
        respondWith: "json",
        responseBody: JSON.stringify({ pong: true }),
      });
    } else {
      n.httpRequest({
        method: "POST",
        url: "https://example.com/api/events",
        sendBody: true,
        specifyBody: "json",
        jsonBody: webhook.body,
      });

      n.respondToWebhook({
        respondWith: "json",
        responseBody: JSON.stringify({ ok: true }),
      });
    }
  },
});
