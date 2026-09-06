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

var CACHE_VERSION = 'wcs-v5';
var CACHE_NAME = 'watercore-' + CACHE_VERSION;
var OFFLINE_URL = '/offline.html';
var RUNTIME_MAX = 60;   // tope LRU del caché de estáticos de runtime

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
  '/offline.html',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
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
  // SIN skipWaiting() automático: el SW nuevo espera en 'waiting' hasta que la
  // página avise al usuario ("hay versión nueva, recargar") y mande SKIP_WAITING.
  // Así no hay "version skew" (código viejo recibiendo assets nuevos a media sesión).
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(c){
      return Promise.all(PRECACHE.map(function(u){
        return c.add(new Request(u, { cache: 'reload' })).catch(function(){ /* opcional */ });
      }));
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil((async function(){
    // Navigation Preload: descarga la navegación en paralelo al arranque del worker
    // (ahorra 100-400 ms por navegación en Android de gama baja).
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch(_){}
    }
    var keys = await caches.keys();
    await Promise.all(keys.map(function(k){
      if (k !== CACHE_NAME && k.indexOf('watercore-') === 0) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

// La página pide activar la versión en espera (tras el aviso al usuario).
self.addEventListener('message', function(e){
  if (e.data === 'skipWaiting' || (e.data && e.data.type === 'SKIP_WAITING')) self.skipWaiting();
});

// Poda LRU simple del caché de runtime (las Cache API keys van en orden de inserción).
async function trimRuntime(){
  var c = await caches.open(CACHE_NAME);
  var ks = await c.keys();
  var sobran = ks.length - (PRECACHE.length + RUNTIME_MAX);
  for (var i = 0; i < sobran; i++) await c.delete(ks[i]);
}

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch(_){ return; }

  // Solo mismo origen. Supabase / fuentes / tiles / Nominatim -> pasan de largo.
  if (url.origin !== self.location.origin) return;

  // Navegación (abrir la app / recargar): usa la respuesta pre-descargada
  // (navigationPreload) si existe; si no, red; y si no hay red, el shell cacheado
  // y como ÚLTIMO recurso la página offline (que devuelve 200 — importante para
  // que un TWA no crashee, ver INFORME-APP-MOVIL).
  if (req.mode === 'navigate') {
    e.respondWith((async function(){
      try {
        var pre = await e.preloadResponse;
        if (pre) { caches.open(CACHE_NAME).then(function(c){ c.put('/index.html', pre.clone()); }); return pre; }
        var net = await fetch(req);
        caches.open(CACHE_NAME).then(function(c){ c.put('/index.html', net.clone()); });
        return net;
      } catch(_) {
        var c = await caches.open(CACHE_NAME);
        return (await c.match('/index.html')) || (await c.match('/')) || (await c.match(OFFLINE_URL));
      }
    })());
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
          caches.open(CACHE_NAME).then(function(c){ c.put(req, copy).then(trimRuntime); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});
