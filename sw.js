/* ============================================================
   DXB Property Expert — Service Worker
   AmirReza Hemmatian | dxbpropertyexpert.com
   ============================================================ */

const CACHE_NAME = 'dxb-property-v4';
const OFFLINE_URL = '/';

// Files to cache on install
const CORE_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_FILES))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH — Network first, cache fallback ────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline fallback
        return caches.match(event.request)
          .then(cached => cached || caches.match(OFFLINE_URL));
      })
  );
});

// ── PUSH NOTIFICATIONS ───────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {
    title: 'DXB Property Expert',
    body: 'New update from AmirReza',
    url: '/'
  };

  const options = {
    body: data.body || 'New update available',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    image: data.image || null,
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'View Now' },
      { action: 'close', title: 'Dismiss' }
    ],
    requireInteraction: false,
    tag: data.tag || 'dxb-update'
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'DXB Property Expert', options)
  );
});

// ── NOTIFICATION CLICK ───────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  if (event.action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Focus existing window if open
        for (const client of windowClients) {
          if (client.url === url && 'focus' in client) {
            return client.focus();
          }
        }
        // Otherwise open new window
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});

// ── BACKGROUND SYNC (for offline form submissions) ───────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-leads') {
    event.waitUntil(syncPendingLeads());
  }
});

async function syncPendingLeads() {
  try {
    const cache = await caches.open('pending-leads');
    const requests = await cache.keys();
    for (const req of requests) {
      const cached = await cache.match(req);
      const data = await cached.json();
      await fetch('https://script.google.com/macros/s/SCRIPT_ID_HERE/exec', {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify(data)
      });
      await cache.delete(req);
    }
  } catch (e) {
    console.log('Sync failed, will retry:', e);
  }
}
