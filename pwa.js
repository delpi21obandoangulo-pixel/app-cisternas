/* ============================================================================
   pwa.js — registro del Service Worker + aviso de "hay una versión nueva".
   Progresivo: si el navegador no soporta SW, o falla el registro, no pasa nada.
   Mismo origen -> CSP script-src 'self'.
   ============================================================================ */
(function(){
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function(){
    navigator.serviceWorker.register('/sw.js').then(function(reg){
      // Detecta una versión nueva esperando para activarse.
      function notifyUpdate(){
        var w = reg.waiting;
        if (!w) return;
        var show = window.fxToast
          ? function(){ window.fxToast('Nueva versión disponible — toca para actualizar', 'ok', 15000); }
          : function(){};
        show();
        // al hacer click en el toast, aplica la actualización
        document.addEventListener('click', function onClick(ev){
          var t = ev.target && ev.target.closest && ev.target.closest('.fx-toast');
          if (!t) return;
          document.removeEventListener('click', onClick, true);
          w.postMessage('skipWaiting');
        }, true);
      }
      if (reg.waiting) notifyUpdate();
      reg.addEventListener('updatefound', function(){
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function(){
          if (nw.state === 'installed' && navigator.serviceWorker.controller) notifyUpdate();
        });
      });
    }).catch(function(){ /* sin SW: la app sigue igual */ });

    // Cuando el SW nuevo toma el control, recarga una vez para servir todo coherente.
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function(){
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });

  // Indicador online/offline discreto (usa el toast si está).
  function net(on){
    if (window.fxToast) window.fxToast(on ? 'Conexión restablecida' : 'Sin conexión — trabajando en local', on ? 'ok' : 'err', 2600);
  }
  window.addEventListener('online',  function(){ net(true); });
  window.addEventListener('offline', function(){ net(false); });
})();
