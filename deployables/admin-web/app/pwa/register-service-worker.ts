export function registerAdminServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  if (!isProductionBuild()) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      // Service worker registration should never block admin workflows.
    });
  });
}

function isProductionBuild() {
  const meta = import.meta as ImportMeta & {
    env?: Readonly<{
      PROD?: boolean;
    }>;
  };

  return meta.env?.PROD === true;
}
