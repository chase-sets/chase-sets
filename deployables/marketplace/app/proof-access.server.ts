import { requireMarketplaceActor } from "./auth.server";

const PROOF_ACCESS_DEFAULT_PERMISSION = "security.manage";
const PROOF_ACCESS_PUBLIC_PATH_PREFIXES = [
  "/account/select",
  "/assets/",
  "/fake-cdn/",
  "/favicon.ico",
  "/favicon.svg",
  "/health/ready",
  "/icons/",
  "/manifest.webmanifest",
  "/service-worker.js",
  "/guest-checkout/exit",
  "/sign-in",
  "/sign-out",
] as const;

function isEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function proofAccessPermission() {
  return process.env.CHASE_SETS_MARKETPLACE_PROOF_ACCESS_PERMISSION?.trim() || PROOF_ACCESS_DEFAULT_PERMISSION;
}

function shouldBypassProofAccessGate(pathname: string) {
  return PROOF_ACCESS_PUBLIC_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function requireMarketplaceProofAccess(request: Request) {
  if (!isEnabled(process.env.CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED)) {
    return null;
  }

  const pathname = new URL(request.url).pathname;
  if (shouldBypassProofAccessGate(pathname)) {
    return null;
  }

  return requireMarketplaceActor(request, proofAccessPermission());
}
