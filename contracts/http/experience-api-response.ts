import { attachResponseMetadata } from "./responses";

export class ExperienceApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `API error ${status}`);
  }
}

export async function parseExperienceApiResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ExperienceApiError(response.status, errorBody);
  }

  return attachResponseMetadata<T>(await response.json(), response);
}
