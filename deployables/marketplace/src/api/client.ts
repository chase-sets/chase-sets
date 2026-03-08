export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "error" in body ? String((body as Record<string, unknown>).error) : `API error ${status}`);
  }
}

const inflightGetRequests = new Map<string, Promise<unknown>>();

async function apiGet<T>(path: string): Promise<T> {
  const requestKey = `GET:${path}`;
  const inflight = inflightGetRequests.get(requestKey);
  if (inflight) {
    return inflight as Promise<T>;
  }

  const request = (async () => {
    const res = await fetch(`/api${path}`, { method: "GET" });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new ApiError(res.status, errorBody);
    }

    return res.json() as Promise<T>;
  })();

  inflightGetRequests.set(requestKey, request);

  try {
    return await request;
  } finally {
    inflightGetRequests.delete(requestKey);
  }
}

export const api = {
  get: <T>(path: string) => apiGet<T>(path),
};
