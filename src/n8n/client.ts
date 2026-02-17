import { createErrorDiagnostic, type Diagnostic, type DiagnosticCode } from "../compiler/diagnostics";
import type { IConnections, INode, IWorkflowSettings } from "n8n-workflow";

const API_BASE_PATH = "/api/v1";
const DEFAULT_DIAGNOSTIC_FILE = "n8n/api";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type N8nWorkflowNode = Omit<INode, "parameters" | "credentials"> & {
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name?: string }>;
};

export type N8nWorkflowNodeDraft = Omit<N8nWorkflowNode, "id">;

type N8nWorkflowSettings = IWorkflowSettings & Record<string, unknown>;

export type N8nWorkflowPayload = {
  name: string;
  nodes: N8nWorkflowNode[];
  connections: IConnections;
  settings: N8nWorkflowSettings;
};

export type N8nWorkflowDraftPayload = Omit<N8nWorkflowPayload, "nodes"> & {
  nodes: N8nWorkflowNodeDraft[];
};

export type N8nWorkflow = {
  id?: string;
  name: string;
  active?: boolean;
  nodes: N8nWorkflowNode[];
  connections: IConnections;
  settings: N8nWorkflowSettings;
};

export type N8nClientOptions = {
  baseUrl: string;
  apiKey: string;
  file?: string;
  fetchFn?: FetchLike;
};

export class N8nClientError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic, options?: { cause?: unknown }) {
    super(diagnostic.message, options);
    this.name = "N8nClientError";
    this.diagnostic = diagnostic;
  }
}

type HttpRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
};

type HttpLayerOptions = {
  baseUrl: string;
  apiKey: string;
  file: string;
  fetchFn: FetchLike;
};

class HttpLayer {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #file: string;
  readonly #fetchFn: FetchLike;
  readonly #secrets: string[];

  constructor(options: HttpLayerOptions) {
    this.#baseUrl = trimTrailingSlash(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#file = options.file;
    this.#fetchFn = options.fetchFn;
    this.#secrets = [options.apiKey];
  }

  async request<T>(request: HttpRequest): Promise<T> {
    const url = buildUrl(this.#baseUrl, request.path, request.query);

    try {
      const response = await this.#fetchFn(url, {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          "X-N8N-API-KEY": this.#apiKey,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
      });

      if (!response.ok) {
        const detail = await readResponseDetail(response);
        throw this.toClientError(
          codeFromStatus(response.status),
          `${request.method} ${request.path} failed (${response.status}): ${detail}`,
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return undefined as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof N8nClientError) {
        throw error;
      }

      const rawMessage = error instanceof Error ? error.message : String(error);
      throw this.toClientError("E_API_NETWORK", `${request.method} ${request.path} network error: ${rawMessage}`, {
        cause: error,
      });
    }
  }

  toClientError(code: DiagnosticCode, message: string, options?: { cause?: unknown }): N8nClientError {
    const maskedMessage = maskSecrets(message, this.#secrets);
    const diagnostic = createErrorDiagnostic({
      code,
      file: this.#file,
      message: maskedMessage,
    });

    return new N8nClientError(diagnostic, options);
  }
}

export function createN8nClient(options: N8nClientOptions) {
  const http = new HttpLayer({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    file: options.file ?? DEFAULT_DIAGNOSTIC_FILE,
    fetchFn: options.fetchFn ?? fetch,
  });

  return {
    async listWorkflows(input?: { name?: string }): Promise<N8nWorkflow[]> {
      const result = await http.request<{ data?: N8nWorkflow[] } | N8nWorkflow[]>({
        method: "GET",
        path: `${API_BASE_PATH}/workflows`,
        query: { name: input?.name },
      });

      if (Array.isArray(result)) {
        return result;
      }

      return result.data ?? [];
    },

    async createWorkflow(payload: N8nWorkflowPayload): Promise<N8nWorkflow> {
      return await http.request<N8nWorkflow>({
        method: "POST",
        path: `${API_BASE_PATH}/workflows`,
        body: payload,
      });
    },

    async updateWorkflow(id: string, payload: N8nWorkflowPayload): Promise<N8nWorkflow> {
      return await http.request<N8nWorkflow>({
        method: "PUT",
        path: `${API_BASE_PATH}/workflows/${encodeURIComponent(id)}`,
        body: payload,
      });
    },

    async getWorkflow(id: string): Promise<N8nWorkflow> {
      const result = await http.request<N8nWorkflow | { data: N8nWorkflow } | undefined>({
        method: "GET",
        path: `${API_BASE_PATH}/workflows/${encodeURIComponent(id)}`,
      });

      if (!result || typeof result !== "object") {
        throw http.toClientError(
          "E_API_NETWORK",
          `GET /workflows/${id} returned unexpected response`,
        );
      }

      // Some n8n versions wrap the response in { data: ... }
      if ("data" in result && !("nodes" in result)) {
        const inner = (result as { data: N8nWorkflow }).data;
        if (!inner || typeof inner !== "object" || !("name" in inner)) {
          throw http.toClientError(
            "E_API_NETWORK",
            `GET /workflows/${id} returned invalid workflow data`,
          );
        }
        return inner;
      }

      if (!("name" in result)) {
        throw http.toClientError(
          "E_API_NETWORK",
          `GET /workflows/${id} returned invalid workflow data`,
        );
      }

      return result as N8nWorkflow;
    },

    async activateWorkflow(id: string): Promise<void> {
      await http.request<void>({
        method: "POST",
        path: `${API_BASE_PATH}/workflows/${encodeURIComponent(id)}/activate`,
      });
    },
  };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function readResponseDetail(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
  }

  const text = await response.text();
  if (text.length > 0) {
    return text;
  }

  return response.statusText || "unknown error";
}

function codeFromStatus(status: number): DiagnosticCode {
  if (status === 401) {
    return "E_API_UNAUTHORIZED";
  }

  if (status === 409) {
    return "E_API_CONFLICT";
  }

  return "E_API_NETWORK";
}

function maskSecrets(input: string, secrets: string[]): string {
  let result = input;

  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    result = result.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      result = result.split(encoded).join("***");
    }
  }

  return result;
}
