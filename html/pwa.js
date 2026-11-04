export async function configurePWA({
  location = window.location,
  navigator = window.navigator,
  caches = window.caches,
  secureContext = window.isSecureContext,
} = {}) {
  if (!secureContext || !('serviceWorker' in navigator)) return true;
  const scope = new URL('./', location.href).href;
  const workerURL = new URL('sw.js', scope).href;
  if (new URL(location.href).searchParams.get('nocache') === '1') {
    // Unregister only this viewer; other apps on the same origin keep working.
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      if (registration.scope === scope) await registration.unregister();
    }
    const prefix = `glbv-${encodeURIComponent(scope)}-`;
    if (caches) {
      for (const name of await caches.keys()) {
        if (name.startsWith(prefix)) await caches.delete(name);
      }
    }
    // Unregistering does not release the current document. Reload once so its
    // CSS, modules and CDN dependencies are fetched without the old controller.
    if (navigator.serviceWorker.controller?.scriptURL === workerURL) {
      location.reload();
      return false;
    }
    return true;
  }
  navigator.serviceWorker.register(workerURL, { updateViaCache: 'none' })
    .catch(error => console.warn('オフラインキャッシュを準備できませんでした。', error));
  return true;
}
