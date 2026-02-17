/**
 * Extract a workflow ID from a raw CLI argument.
 *
 * Accepts:
 *   - Plain numeric or alphanumeric ID: "123", "abc123"
 *   - n8n editor URL: "https://n8n.example.com/workflow/123"
 *   - n8n editor URL with hash: "https://n8n.example.com/workflow/123#some-fragment"
 *   - n8n editor URL with subpath: "https://n8n.example.com/n8n/workflow/123"
 *
 * Returns `{ id, baseUrl }` where baseUrl is extracted from the URL origin
 * (only when a URL is given). Returns null if the input cannot be parsed.
 */
export type ExtractedWorkflowTarget = {
  id: string;
  baseUrl?: string;
};

export function extractWorkflowId(input: string): ExtractedWorkflowTarget | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Try URL parse
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return extractFromUrl(trimmed);
  }

  // Plain ID (alphanumeric, dashes, underscores)
  if (/^[\w-]+$/.test(trimmed)) {
    return { id: trimmed };
  }

  return null;
}

function extractFromUrl(raw: string): ExtractedWorkflowTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // Match /workflow/{id} at any depth in the path
  const match = url.pathname.match(/\/workflow\/([^/]+)\/?$/);
  if (!match?.[1]) {
    return null;
  }

  // Derive baseUrl: origin + everything before /workflow/
  const workflowIndex = url.pathname.indexOf("/workflow/");
  const prefix = url.pathname.slice(0, workflowIndex);
  const baseUrl = `${url.origin}${prefix}`;

  return {
    id: match[1],
    baseUrl,
  };
}
