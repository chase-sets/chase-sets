import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";

export const tcgplayerLiveExportAuthorityVersion = "TcgplayerLiveExportAuthority/v1";

/**
 * Closed provider authority for the worker-origin Export From Live GET. Captured facts come from
 * #7924 comment 5647783852 and #7026 comment 5555055372; credentials and redirect are client policy
 * (#7328 A.5). Changing a captured field needs a new capture and authority version.
 */
export const tcgplayerLiveExportAuthority = Object.freeze({
  host: "store.tcgplayer.com",
  path: "/Admin/Pricing/DownloadMyExportCSV",
  query: "type=Pricing",
  method: "GET",
  credentials: "include",
  redirect: "manual",
  status: 200,
  contentType: "text/csv",
  header: tcgplayerLiveExportHeader,
  origin: "worker",
  capturedAt: "2026-09-12T18:11:47.485Z",
} as const);
export type TcgplayerLiveExportAuthority = typeof tcgplayerLiveExportAuthority;

/** The authority URL at its captured host, or at a labelled synthetic loopback origin for hermetic harnesses. */
export function liveExportAuthorityUrl(
  origin = `https://${tcgplayerLiveExportAuthority.host}`,
  authority: TcgplayerLiveExportAuthority = tcgplayerLiveExportAuthority,
): URL {
  const url = new URL(`${authority.path}?${authority.query}`, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !(
      (url.protocol === "https:" && url.host === authority.host) ||
      (url.protocol === "http:" && url.hostname === "127.0.0.1")
    )
  )
    throw new Error("live-export-authority-origin-refused");
  return url;
}

/** True only for the exact authority method, path and query; the caller still owns the registered-origin fence. */
export function isLiveExportAuthorityRequest(
  request: Readonly<{ method: string; url: string }>,
  authority: TcgplayerLiveExportAuthority = tcgplayerLiveExportAuthority,
): boolean {
  const url = new URL(request.url);
  return (
    request.method === authority.method &&
    url.pathname === authority.path &&
    url.search === `?${authority.query}` &&
    !url.hash
  );
}
