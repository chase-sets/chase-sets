export type AuthFormActionLocation = Readonly<{
  pathname: string;
  search?: string;
}>;

export function authFormActionFromLocation(location: AuthFormActionLocation) {
  const search = location.search ?? "";
  if (!new URLSearchParams(search).has("socialLoginError")) return `${location.pathname}${search}`;
  // Retire social failures on submission without re-encoding return-path query bytes.
  const parameters = search
    .replace(/^\?/, "")
    .split("&")
    .filter((parameter) => !new URLSearchParams(parameter).has("socialLoginError"))
    .join("&");
  return `${location.pathname}${parameters ? `?${parameters}` : ""}`;
}

export function authFormActionFromRequest(request: Request) {
  const url = new URL(request.url);
  return authFormActionFromLocation(url);
}
