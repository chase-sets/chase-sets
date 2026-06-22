export type AuthFormActionLocation = Readonly<{
  pathname: string;
  search?: string;
}>;

export function authFormActionFromLocation(location: AuthFormActionLocation) {
  return `${location.pathname}${location.search ?? ""}`;
}

export function authFormActionFromRequest(request: Request) {
  const url = new URL(request.url);
  return authFormActionFromLocation(url);
}
