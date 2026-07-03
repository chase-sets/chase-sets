type WebLoaderArgs = Readonly<{
  request: Request;
}>;

export function createFaviconLoader(svg: string) {
  return function loader(_args: WebLoaderArgs) {
    return new Response(svg, {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "Content-Type": "image/svg+xml; charset=utf-8",
      },
    });
  };
}

export function createChromeDevtoolsLoader() {
  return function loader(_args: WebLoaderArgs) {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  };
}

export function createWebReadyLoader(service: string) {
  return function loader({ request }: WebLoaderArgs) {
    return Response.json({
      ok: true,
      service,
      checkedAt: new Date().toISOString(),
      origin: new URL(request.url).origin,
    });
  };
}
