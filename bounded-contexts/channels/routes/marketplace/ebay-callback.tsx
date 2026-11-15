import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { redirect, type LoaderFunctionArgs } from "react-router";
import { createEbayConnectionClient } from "../../features/ebay-connection/ui/api-client";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url),
    declined = url.pathname.endsWith("/declined");
  const cleanUrl = new URL("/account/channels/ebay", url.origin);
  const cleanRequest = new Request(cleanUrl, { headers: request.headers, signal: request.signal });
  try {
    await requireActorFromAuthApi({ request: cleanRequest, permission: "channels.manage" });
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("Cache-Control", "no-store");
      error.headers.set("Referrer-Policy", "no-referrer");
      return error;
    }
    return redirect("/account/channels/ebay?outcome=failed", {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  let destination = `/account/channels/ebay?outcome=${declined ? "declined" : "failed"}`;
  try {
    const state = url.searchParams.get("state");
    if (
      !state ||
      url.searchParams.getAll("state").length !== 1 ||
      (!declined && url.searchParams.getAll("code").length !== 1)
    )
      throw new Error();
    const result = await createEbayConnectionClient(cleanRequest)(
      declined ? "/declined" : "/callback",
      declined ? { state } : { state, code: url.searchParams.get("code") },
    );
    if (!declined && result && typeof result === "object" && typeof Reflect.get(result, "connectionId") === "string")
      destination = `/account/channels/ebay?connectionId=${encodeURIComponent(Reflect.get(result, "connectionId"))}`;
  } catch {
    destination = "/account/channels/ebay?outcome=failed";
  }
  return redirect(destination, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
