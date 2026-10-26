// Replaces the service worker of a retired preview (#118). A browser that still has the old worker
// installed fetches this file at the same URL, so the worker removes only its own scope's caches,
// unregisters itself and sends open tabs to the real app. Caches are shared by the whole origin, so
// only workbox precache names that end in this scope are touched.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const scope = self.registration.scope
    for (const name of await caches.keys()) if (name.endsWith(scope)) await caches.delete(name)
    const tabs = await self.clients.matchAll({ type: 'window' })
    await self.registration.unregister()
    const home = new URL('../', scope).href
    for (const tab of tabs) tab.navigate(home).catch(() => {})
  })())
})
