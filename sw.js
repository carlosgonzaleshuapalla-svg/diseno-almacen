/* Service worker generado por herramientas/construir_web.py — no editar a mano. */
const VERSION = 'almacen-39127e99cc66';
const ARCHIVOS = ["./analisis.js", "./app.js", "./compartir.js", "./estilos.css", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./", "./manifest.webmanifest", "./motor.js", "./registro-sw.js", "./vista3d.js"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Red primero para lo propio (las actualizaciones llegan de inmediato; «no-cache» obliga a revisar si el archivo cambió).
   Si la red tarda más de 4 s o no hay internet, se usa lo guardado: la app funciona sin conexión. */
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  const red = fetch(r.url, { cache: 'no-cache', credentials: 'same-origin' }).then(resp => {
    if (resp && resp.ok) { const copia = resp.clone(); caches.open(VERSION).then(c => c.put(r, copia)); }
    return resp;
  });
  const lento = new Promise((_, no) => setTimeout(() => no(new Error('lento')), 4000));
  e.respondWith(Promise.race([red, lento]).catch(() =>
    caches.match(r, { ignoreSearch: true })
      .then(x => x || (r.mode === 'navigate' ? caches.match('./') : null))
      .then(x => x || red)));
});
