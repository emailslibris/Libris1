const CACHE_NAME = 'libris-shell-v1'
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './local-store.mjs',
  './local-data.mjs',
  './firebase.js',
  './manifest.webmanifest',
  './Librissf.png',
  './icons/libris-192.png',
  './icons/libris-512.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FILES)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('libris-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')))
    return
  }

  const isAppFile = STATIC_FILES.some((file) => new URL(file, self.registration.scope).pathname === url.pathname)
  if (!isAppFile) return

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    }).catch(() => caches.match(request))
  )
})
