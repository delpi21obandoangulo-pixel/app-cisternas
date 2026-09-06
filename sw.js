/* ============================================================================
   sw.js — Service Worker de WaterCore Space
   ----------------------------------------------------------------------------
   Hace la app INSTALABLE y utilizable SIN conexión (los choferes trabajan en
   campo con señal intermitente). Estrategia:
     - shell + vendor: precache en install, y luego stale-while-revalidate.
     - navegación: network-first con fallback al index cacheado (modo offline).
     - CUALQUIER cosa de otro origen (Supabase, fuentes, tiles, Nominatim): se
       deja pasar sin tocar — nunca se cachea la API ni datos.
   Sube CACHE_VERSION en cada despliegue para invalidar el caché viejo.
   La app ya funciona sin SW (localStorage); esto solo la mejora.
   ============================================================================ */
'use strict';

var CACHE_VERSION = 'wcs-v4';
var CACHE_NAME = 'watercore-' + CACHE_VERSION;

// Código de la app: SIEMPRE red primero (así un deploy nuevo se ve al instante
// estando online) y el caché solo es el respaldo sin conexión. No hace falta
// subir CACHE_VERSION en cada deploy por estos.
var NETWORK_FIRST = /\/(index\.html|app\.js|ui-fx\.js|ui-fx\.css|pwa\.js)$/;

var PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/ui-fx.css',
  '/ui-fx.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/supabase-js.js',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(c){
      // addAll es atómico: si UNO falla, no rompe la instalación entera.
      return Promise.all(PRECACHE.map(function(u){
        return c.add(new Request(u, { cache: 'reload' })).catch(function(){ /* opcional */ });
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if (k !== CACHE_NAME && k.indexOf('watercore-') === 0) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// Permite que la página fuerce la activación de una versión nueva sin recargar dos veces.
self.addEventListener('message', function(e){
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch(_){ return; }

  // Solo mismo origen. Supabase / fuentes / tiles / Nominatim -> pasan de largo.
  if (url.origin !== self.location.origin) return;

  // Navegación (abrir la app / recargar): red primero, y si no hay red, el shell.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(c){ c.put('/index.html', copy); });
        return res;
      }).catch(function(){
        return caches.match('/index.html').then(function(m){ return m || caches.match('/'); });
      })
    );
    return;
  }

  // Código de la app (index/app.js/ui-fx/pwa): RED PRIMERO. Fresco si hay internet;
  // el caché solo entra si la red falla.
  if (NETWORK_FIRST.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(function(res){
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); });
        }
        return res;
      }).catch(function(){ return caches.match(req); })
    );
    return;
  }

  // Resto de estáticos mismo origen (vendor, iconos, imágenes, manifest):
  // cache-first + revalidación en segundo plano.
  e.respondWith(
    caches.match(req).then(function(cached){
      var network = fetch(req).then(function(res){
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});
