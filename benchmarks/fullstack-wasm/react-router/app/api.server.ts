import { toItemView, type ItemView } from "./view-model";

const base = process.env.API_BASE ?? "http://localhost:8080";

export async function fetchItem(id: string): Promise<ItemView | null> {
  const res = await fetch(`${base}/api/discovery/items/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`item API returned ${res.status}`);
  return toItemView(await res.json());
}
