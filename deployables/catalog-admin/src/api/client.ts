export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "error" in body ? String((body as Record<string, unknown>).error) : `API error ${status}`);
  }
}

// TODO: Replace with real auth when available
const DEV_HEADERS = {
  "X-Tenant-Id": "tenant_dev",
  "X-User-Id": "user_dev",
  "X-Account-Id": "account_dev",
};

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    ...DEV_HEADERS,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(res.status, errorBody);
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => apiRequest<T>("GET", path),
  post: <T>(path: string, body?: unknown) => apiRequest<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => apiRequest<T>("PUT", path, body),
  del: <T>(path: string, body?: unknown) => apiRequest<T>("DELETE", path, body),
};
