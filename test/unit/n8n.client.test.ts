import { expect, test } from "bun:test";
import { createN8nClient, type FetchLike, N8nClientError } from "../../src/n8n/client";

test("APIキー認証ヘッダを付与して /api/v1/workflows にアクセスする", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = createN8nClient({
    baseUrl: "https://n8n.example.com/",
    apiKey: "n8n-secret-token",
    fetchFn,
  });

  await client.listWorkflows({ name: "sample" });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.input).toBe("https://n8n.example.com/api/v1/workflows?name=sample");
  const headers = new Headers(calls[0]?.init?.headers);
  expect(headers.get("X-N8N-API-KEY")).toBe("n8n-secret-token");
});

test("401/409/ネットワークエラーを診断コードへ変換する", async () => {
  const file = "deploy.ts";
  const unauthorizedClient = createN8nClient({
    baseUrl: "https://n8n.example.com",
    apiKey: "top-secret-key",
    file,
    fetchFn: async () =>
      new Response(JSON.stringify({ message: "invalid key top-secret-key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });

  const conflictClient = createN8nClient({
    baseUrl: "https://n8n.example.com",
    apiKey: "top-secret-key",
    file,
    fetchFn: async () =>
      new Response(JSON.stringify({ message: "workflow already exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  });

  const networkClient = createN8nClient({
    baseUrl: "https://n8n.example.com",
    apiKey: "top-secret-key",
    file,
    fetchFn: async () => {
      throw new Error("ECONNREFUSED: top-secret-key");
    },
  });

  const payload = { name: "wf", nodes: [], connections: {}, settings: {} };

  await expect(unauthorizedClient.createWorkflow(payload)).rejects.toMatchObject({
    diagnostic: expect.objectContaining({ code: "E_API_UNAUTHORIZED", file }),
  });

  await expect(conflictClient.updateWorkflow("1", payload)).rejects.toMatchObject({
    diagnostic: expect.objectContaining({ code: "E_API_CONFLICT", file }),
  });

  await expect(networkClient.activateWorkflow("1")).rejects.toMatchObject({
    diagnostic: expect.objectContaining({ code: "E_API_NETWORK", file }),
  });
});

test("診断メッセージ内の秘密情報をマスクする", async () => {
  const apiKey = "ultra-sensitive-api-key";
  const client = createN8nClient({
    baseUrl: "https://n8n.example.com",
    apiKey,
    fetchFn: async () => {
      throw new Error(`network failed with key=${apiKey}`);
    },
  });

  try {
    await client.listWorkflows();
    throw new Error("expected N8nClientError");
  } catch (error) {
    expect(error).toBeInstanceOf(N8nClientError);
    const n8nError = error as N8nClientError;
    expect(n8nError.diagnostic.message).not.toContain(apiKey);
    expect(n8nError.diagnostic.message).toContain("***");
  }
});
