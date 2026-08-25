/* eslint-env serviceworker */

/**
 * The service worker, written by hand because push needs it to be.
 *
 * vite-plugin-pwa's generateSW mode writes this file for us, and what it writes
 * has no `push` and no `notificationclick` listener — there is no option that
 * adds them, because Workbox has nothing to say about what a notification
 * should look like. So the plugin switches to injectManifest, which builds this
 * source and only fills in the precache list.
 *
 * Plain JavaScript rather than TypeScript on purpose: a service worker needs
 * the WebWorker lib, the app needs DOM, and the two cannot share one tsconfig
 * program. A second tsconfig for one file costs more than it explains, and
 * `tsc --noEmit` skips .js without allowJs, so this file is simply outside the
 * typecheck rather than fighting it.
 *
 * The push and notificationclick handlers are the legacy worker's (root sw.js),
 * ported as they were — they are the part that already worked.
 */

// Injected by the build. Referencing it is mandatory in injectManifest mode:
// the build fails outright if this symbol never appears.
const MANIFEST = self.__WB_MANIFEST || []

const CACHE_NAME = 'team-eysl-shell'
// Deduplicated: the icons and the manifest are listed twice in the injected
// array, once by the glob and once by the web app manifest's own icon list.
// Without this, install fetches each of them twice for no reason.
const PRECACHE_URLS = [
  ...new Set(
    MANIFEST.map(
      (entry) => new URL(typeof entry === 'string' ? entry : entry.url, self.location.origin).href,
    ),
  ),
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // allSettled, not all: one asset the network refuses today should not
      // leave the worker permanently uninstalled, and the fetch handler falls
      // back to the network for anything missing here anyway.
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Every build hashes its asset names, so yesterday's entries are dead
      // weight in a cache keyed by a constant. Dropping the ones this build
      // does not list is what stops it growing forever — the legacy worker
      // deleted every cache on activate and re-downloaded the whole app each
      // time (root sw.js:3).
      const wanted = new Set(PRECACHE_URLS)
      const cache = await caches.open(CACHE_NAME)
      for (const request of await cache.keys()) {
        if (!wanted.has(request.url)) await cache.delete(request)
      }
      for (const name of await caches.keys()) {
        if (name !== CACHE_NAME) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

/**
 * Network first, cache as the fallback — the legacy worker's policy.
 *
 * Right for this app: almost every screen reads from Supabase, so a stale
 * shell served confidently is worse than a slow one. Only same-origin GETs are
 * touched; a Supabase request that fails should fail, not resolve from a cache
 * that cannot know whether the answer is still true.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request)
        if (response.ok && PRECACHE_URLS.includes(url.href)) {
          const cache = await caches.open(CACHE_NAME)
          await cache.put(request, response.clone())
        }
        return response
      } catch (error) {
        const cached = await caches.match(request)
        if (cached) return cached
        // An offline navigation still has somewhere to go: the app shell is
        // precached, and the router draws the rest.
        if (request.mode === 'navigate') {
          const shell = await caches.match(new URL('/index.html', self.location.origin).href)
          if (shell) return shell
        }
        throw error
      }
    })(),
  )
})

/**
 * A push arrived.
 *
 * The payload shape is the legacy sender's: { title, body, icon, badge, tag,
 * url }. Nothing writes it yet — sending needs the VAPID private key and a
 * server to hold it, neither of which exists — so this is written to the
 * contract the old push-notify Edge Function used, which is what the club's
 * existing subscriptions already expect.
 *
 * A malformed payload still shows something. A push event that resolves
 * without showing a notification costs the origin its push permission in
 * Chrome, so silence is not an option here.
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'TEAM EYSL', {
      body: data.body || '새 알림이 도착했어요.',
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/icon-192.png',
      tag: data.tag || `team-eysl-${Date.now()}`,
      renotify: true,
      silent: false,
      timestamp: Date.now(),
      data: { url: data.url || '/' },
      vibrate: [120, 60, 120],
    }),
  )
})

/**
 * The member tapped a notification.
 *
 * Focus a window that is already open and take it to the right screen rather
 * than opening a second copy of the app. Ported unchanged from the legacy
 * worker, including the URL being resolved against this origin — a payload
 * that named another host would otherwise navigate the app off itself.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if ('focus' in client) {
          if ('navigate' in client) await client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : null
    })(),
  )
})

/**
 * The browser replaced our subscription.
 *
 * It happens on its own schedule — a push service rotating endpoints, a
 * reinstall — and the new subscription has to be stored or notifications stop
 * arriving silently. This worker cannot store it: writing to push_subscriptions
 * needs the member's Supabase session, which lives in the page, not here.
 *
 * So it re-subscribes with the same application server key and stops there. The
 * row in the database is now stale, and 알림 설정 is what notices: it compares
 * this browser's endpoint against the stored ones and shows 알림 등록이
 * 만료됐습니다 with a 다시 등록 button, rather than reporting 알림 받는 중 for a
 * subscription nothing can reach.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription?.options
  if (!options?.applicationServerKey) return

  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: options.applicationServerKey,
    }),
  )
})
