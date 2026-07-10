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

// Mirrors infrastructure/platform-runtime/health.ts's `/live` handler: a pure
// process-liveness check with no database, platform-api, or other upstream
// call, so a briefly slow readiness dependency never trips the kubelet
// liveness probe and kills a healthy pod (#4767, following #4765/#4766).
export function createWebLiveLoader() {
  return function loader(_args: WebLoaderArgs) {
    return Response.json({
      status: "ok",
    });
  };
}
