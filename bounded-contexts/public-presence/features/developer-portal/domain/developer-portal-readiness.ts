export const DEVELOPER_PORTAL_READINESS_ENV = "CHASE_SETS_M86_DEVELOPER_PORTAL_READY";

export function isDeveloperPortalReady(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env[DEVELOPER_PORTAL_READINESS_ENV]?.trim().toLowerCase() === "true";
}

export function requireDeveloperPortalReady(env?: Readonly<Record<string, string | undefined>>) {
  if (!isDeveloperPortalReady(env)) throw new Response("Not found", { status: 404 });
}

export const developerPortalRobotsMeta = { name: "robots", content: "noindex,nofollow" } as const;

export const developerPortalResponseHeaders = {
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
  "X-Robots-Tag": "noindex, nofollow",
} as const;
