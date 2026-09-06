/* ============================================================================
   ui-fx.js — motor de los "menús esponja" y microinteracciones.
   ----------------------------------------------------------------------------
   PROGRESIVO y AISLADO: no toca la lógica de app.js. Sólo añade capas visuales
   y listeners. Si falla o no carga, la app sigue igual. Respeta
   prefers-reduced-motion. Sólo anima transform/opacity/filter (60fps).
   Se sirve desde 'self' (CSP script-src 'self').
   ========================================================================== */
(function(){
  'use strict';
  if (window.__uiFxLoaded) return; window.__uiFxLoaded = true;

  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){}
  var coarse = false;
  try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch(e){}

  var $  = function(s, r){ return (r||document).querySelector(s); };
  var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
  var raf = window.requestAnimationFrame || function(f){ return setTimeout(f, 16); };
  var clamp = function(v, a, b){ return v < a ? a : v > b ? b : v; };

  function ready(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once:true });
    else fn();
  }
  // agrupa ráfagas de mutaciones (la agenda reconcilia nodos sin parar) en una
  // sola pasada, para no escanear el DOM en cada micro-cambio.
  function debounce(fn, ms){
    var t = null;
    return function(){ clearTimeout(t); t = setTimeout(fn, ms || 120); };
  }

  /* ===================================================================
     1. MENÚ ESPONJA — blob de gel que sigue a la pestaña activa
     =================================================================== */
  function initGelNav(){
    var nav = document.getElementById('viewTabs');
    if (!nav) return;
    if (getComputedStyle(nav).position === 'static') nav.style.position = 'sticky';

    var blob = document.createElement('div');
    blob.className = 'fx-gel-blob';
    blob.setAttribute('aria-hidden', 'true');
    nav.insertBefore(blob, nav.firstChild);

    var moveTimer = null, scheduled = null, lastKey = '', placedOnce = false;
    function doPlace(animate){
      var active = nav.querySelector('.view-tab.active');
      // pestañas ocultas por rol: si la activa no se ve, esconde el blob
      if (!active || active.hidden || active.offsetParent === null){
        blob.style.opacity = '0';
        lastKey = 'hidden';
        return;
      }
      var navBox = nav.getBoundingClientRect();
      var box = active.getBoundingClientRect();
      var x = box.left - navBox.left + nav.scrollLeft;
      var w = box.width;
      var key = Math.round(x) + ':' + Math.round(w);
      if (key === lastKey && blob.style.opacity === '1') return; // nada que mover
      lastKey = key;
      // La PRIMERA colocación va sin transición: así no hay un "deslizamiento"
      // desde left:0 al cargar. Las siguientes sí animan (gelatina).
      var noAnim = !placedOnce || !animate || reduce;
      if (noAnim) blob.style.transition = 'none';
      blob.style.opacity = '1';
      if (animate && !reduce && placedOnce){
        blob.classList.add('is-moving');
        clearTimeout(moveTimer);
        moveTimer = setTimeout(function(){ blob.classList.remove('is-moving'); }, 440);
      }
      blob.style.left = x + 'px';
      blob.style.width = w + 'px';
      if (noAnim){
        void blob.offsetWidth;              // fuerza reflow
        blob.style.transition = '';         // devuelve la transición para lo siguiente
      }
      placedOnce = true;
    }
    // coalescer ráfagas en un solo tick. setTimeout (no rAF) para que SIEMPRE
    // dispare aunque la pestaña esté en segundo plano o el entorno frene el rAF.
    function place(animate){
      clearTimeout(scheduled);
      scheduled = setTimeout(function(){ try { doPlace(animate); } catch(_){} }, 20);
    }

    // primera colocación (tras fuentes / layout)
    place(false);
    setTimeout(function(){ place(false); }, 250);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function(){ place(false); });

    // cambia de pestaña => cambia la clase 'active'. NO observamos 'style' (el blob
    // vive dentro del nav y cambiar su style dispararía el observer en bucle).
    var mo = new MutationObserver(function(muts){
      for (var i = 0; i < muts.length; i++){ if (muts[i].target !== blob){ place(true); return; } }
    });
    mo.observe(nav, { attributes:true, subtree:true, attributeFilter:['class','hidden'] });

    window.addEventListener('resize', function(){ place(false); }, { passive:true });
    nav.addEventListener('scroll', function(){ place(false); }, { passive:true });
    // por si el rol cambia y se muestran/ocultan pestañas sin tocar 'active'
    setInterval(function(){ place(false); }, 2500);
  }

  /* ===================================================================
     2. SQUISH + RIPPLE al pulsar (delegado, para todo control)
     =================================================================== */
  var PRESS_SEL = '.btn, .btn-ghost, .btn-icon, .btn-mini, .view-tab, .sub-tab, .filter-btn, .chip, .day-chip, .home-card';
  function initPress(){
    document.addEventListener('pointerdown', function(e){
      var el = e.target && e.target.closest && e.target.closest(PRESS_SEL);
      if (!el || el.disabled) return;
      el.classList.remove('fx-release');
      el.classList.add('fx-squish');
      // (el ripple ya lo hace app.js -> initRipples; aquí solo el squish/gel)
    }, true);

    function release(e){
      var el = e.target && e.target.closest && e.target.closest(PRESS_SEL);
      if (!el) { $$('.fx-squish').forEach(function(n){ n.classList.remove('fx-squish'); }); return; }
      el.classList.remove('fx-squish');
      if (!reduce && (el.classList.contains('btn') || el.classList.contains('btn-ghost') || el.classList.contains('btn-icon'))){
        el.classList.add('fx-release');
        setTimeout(function(){ el.classList.remove('fx-release'); }, 460);
      }
    }
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    document.addEventListener('pointerleave', release, true);
  }

  /* ===================================================================
     3. HALO que sigue al cursor + efecto MAGNÉTICO en .btn
     =================================================================== */
  function initMagnetic(){
    if (coarse || reduce) return;
    document.addEventListener('pointermove', function(e){
      var btn = e.target && e.target.closest && e.target.closest('.btn');
      if (!btn) return;
      var box = btn.getBoundingClientRect();
      var mx = (e.clientX - box.left) / box.width * 100;
      var my = (e.clientY - box.top) / box.height * 100;
      btn.style.setProperty('--mx', mx + '%');
      btn.style.setProperty('--my', my + '%');
      // tirón magnético (máx ~7px)
      btn.classList.add('fx-magnetic', 'fx-pulling');
      var dx = clamp((e.clientX - (box.left + box.width/2)) / (box.width/2), -1, 1) * 7;
      var dy = clamp((e.clientY - (box.top + box.height/2)) / (box.height/2), -1, 1) * 7;
      btn.style.setProperty('--fx-tx', dx.toFixed(1) + 'px');
      btn.style.setProperty('--fx-ty', dy.toFixed(1) + 'px');
    }, { passive:true });
    document.addEventListener('pointerout', function(e){
      var btn = e.target && e.target.closest && e.target.closest('.btn');
      if (!btn) return;
      btn.classList.remove('fx-pulling');
      btn.style.setProperty('--fx-tx', '0px');
      btn.style.setProperty('--fx-ty', '0px');
    }, { passive:true });
  }

  /* ===================================================================
     4. TILT parallax en tarjetas / paneles
     =================================================================== */
  function initTilt(){
    if (coarse || reduce) return;
    var TILT_SEL = '.home-card, .stat-tile, .panel';
    var frame = null, pending = null;
    document.addEventListener('pointermove', function(e){
      var card = e.target && e.target.closest && e.target.closest(TILT_SEL);
      if (!card){ return; }
      pending = { card:card, x:e.clientX, y:e.clientY };
      if (frame) return;
      frame = raf(function(){
        frame = null;
        if (!pending) return;
        var c = pending.card, box = c.getBoundingClientRect();
        var px = (pending.x - box.left) / box.width - 0.5;
        var py = (pending.y - box.top) / box.height - 0.5;
        c.classList.add('fx-tilt', 'fx-lift');
        c.style.setProperty('--fx-ry', (px * 7).toFixed(2) + 'deg');
        c.style.setProperty('--fx-rx', (-py * 7).toFixed(2) + 'deg');
      });
    }, { passive:true });
    document.addEventListener('pointerout', function(e){
      var card = e.target && e.target.closest && e.target.closest(TILT_SEL);
      if (!card) return;
      card.classList.remove('fx-lift');
      card.style.setProperty('--fx-rx', '0deg');
      card.style.setProperty('--fx-ry', '0deg');
      setTimeout(function(){ if (card.style.getPropertyValue('--fx-rx') === '0deg') card.classList.remove('fx-tilt'); }, 300);
    }, { passive:true });
  }

  /* ===================================================================
     5. ENTRADA al hacer scroll (paneles y tarjetas de inicio)
     =================================================================== */
  function initScrollIn(){
    if (reduce || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function(entries){
      var i = 0;
      entries.forEach(function(en){
        if (en.isIntersecting){
          var el = en.target;
          el.style.setProperty('--fx-delay', (i++ * 55) + 'ms');
          el.classList.add('fx-shown');
          io.unobserve(el);
        }
      });
    }, { threshold:0.08, rootMargin:'0px 0px -6% 0px' });

    function tag(root){
      $$('.home-card, .panel', root || document).forEach(function(el){
        // no tocar tarjetas de la agenda en vivo (tienen su propia animación y reconciliación)
        if (el.closest('#timelineList')) return;
        if (el.classList.contains('fx-in') || el.classList.contains('fx-shown')) return;
        el.classList.add('fx-in');
        io.observe(el);
      });
    }
    tag(document);

    // vistas que se muestran después / contenido re-renderizado. Debounced y con
    // re-escaneo global barato (tag() ya ignora lo que no aplica y lo ya marcado).
    var main = document.querySelector('main') || document.body;
    var rescan = debounce(function(){ tag(document); }, 200);
    var mo = new MutationObserver(function(muts){
      for (var i = 0; i < muts.length; i++){
        var m = muts[i];
        if (m.target && m.target.id === 'timelineList') continue; // agenda: su propia animación
        if (m.addedNodes && m.addedNodes.length){ rescan(); return; }
      }
    });
    mo.observe(main, { childList:true, subtree:true });
  }

  /* ===================================================================
     6. NÚMEROS que ruedan + tile que late al cambiar
     =================================================================== */
  function animateNumber(el, from, to){
    var start = null, dur = 620;
    var pre = (el.__fxPre || ''), suf = (el.__fxSuf || '');
    var dec = /\./.test(String(to)) ? 2 : 0;
    function step(ts){
      if (start === null) start = ts;
      var p = clamp((ts - start) / dur, 0, 1);
      var e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      var val = from + (to - from) * e;
      el.textContent = pre + val.toFixed(dec) + suf;
      if (p < 1) raf(step);
      else el.textContent = pre + to.toFixed(dec) + suf;
    }
    raf(step);
  }
  function parseNum(txt){
    var m = String(txt).match(/^(\D*?)(-?\d[\d\s.,]*)(\D*)$/);
    if (!m) return null;
    var num = parseFloat(m[2].replace(/\s/g,'').replace(/,/g,''));
    if (!isFinite(num)) return null;
    return { pre:m[1], num:num, suf:m[3] };
  }
  function initNumberRoll(){
    if (reduce) return;
    var SEL = '.stat-tile .value, .kpi-value, .value.mono';
    function watch(el){
      if (el.__fxNumWatched) return; el.__fxNumWatched = true;
      var parsed = parseNum(el.textContent);
      if (parsed){ el.__fxPre = parsed.pre; el.__fxSuf = parsed.suf; el.__fxNum = parsed.num; }
      var mo = new MutationObserver(function(){
        var p = parseNum(el.textContent);
        if (!p) return;
        if (el.__fxNum != null && p.num !== el.__fxNum && Math.abs(p.num - el.__fxNum) > 0.001){
          var oldN = el.__fxNum;
          el.__fxPre = p.pre; el.__fxSuf = p.suf;
          el.__fxNum = p.num;
          mo.disconnect();
          animateNumber(el, oldN, p.num);
          setTimeout(function(){ mo.observe(el, { childList:true, characterData:true, subtree:true }); }, 700);
          var tile = el.closest('.stat-tile') || el;
          tile.classList.add('fx-bump');
          setTimeout(function(){ tile.classList.remove('fx-bump'); }, 440);
        } else {
          el.__fxNum = p.num;
        }
      });
      mo.observe(el, { childList:true, characterData:true, subtree:true });
    }
    $$(SEL).forEach(watch);
    var rescan = debounce(function(){ $$(SEL).forEach(watch); }, 200);
    var mo = new MutationObserver(function(muts){
      for (var i = 0; i < muts.length; i++){
        if (muts[i].target && muts[i].target.id === 'timelineList') continue;
        rescan(); return;
      }
    });
    mo.observe(document.body, { childList:true, subtree:true });
  }

  /* ===================================================================
     6b. ATAJOS DE TECLADO — Alt+1..9 cambia de pestaña; "?" muestra la ayuda
     =================================================================== */
  function initShortcuts(){
    function enCampo(el){
      if (!el) return false;
      var t = (el.tagName || '').toLowerCase();
      return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
    }
    document.addEventListener('keydown', function(e){
      if (e.ctrlKey || e.metaKey) return;
      if (enCampo(e.target)) return;
      // Alt + dígito -> N-ésima pestaña visible
      if (e.altKey && /^[1-9]$/.test(e.key)){
        var vis = $$('.view-tab').filter(function(b){ return !b.hidden && b.offsetParent !== null; });
        var target = vis[parseInt(e.key, 10) - 1];
        if (target){ e.preventDefault(); target.click(); }
        return;
      }
      // "?" -> ayuda
      if (e.key === '?' && !e.altKey){
        e.preventDefault();
        if (window.fxToast) window.fxToast('Atajos: Alt+1…9 cambia de pestaña · Esc cierra ventanas', '', 4200);
      }
      // Esc -> cierra modales abiertos
      if (e.key === 'Escape'){
        $$('.modal-backdrop').forEach(function(m){ if (!m.hidden) m.hidden = true; });
      }
    });
  }

  /* ===================================================================
     7. TOASTS — window.fxToast(mensaje, 'ok'|'err'|'')
     =================================================================== */
  function initToast(){
    var layer = document.createElement('div');
    layer.id = 'fxToastLayer';
    document.body.appendChild(layer);
    window.fxToast = function(msg, kind, ms){
      try{
        var t = document.createElement('div');
        t.className = 'fx-toast ' + (kind || '');
        t.textContent = String(msg == null ? '' : msg).slice(0, 200);
        layer.appendChild(t);
        setTimeout(function(){
          t.classList.add('fx-out');
          setTimeout(function(){ t.remove(); }, 260);
        }, ms || 3200);
      }catch(_){}
    };
  }

  /* ===================================================================
     Arranque
     =================================================================== */
  ready(function(){
    try { initGelNav(); }    catch(e){ console.warn('ui-fx gelNav', e); }
    try { initPress(); }      catch(e){ console.warn('ui-fx press', e); }
    try { initMagnetic(); }   catch(e){ console.warn('ui-fx magnetic', e); }
    try { initTilt(); }       catch(e){ console.warn('ui-fx tilt', e); }
    try { initScrollIn(); }   catch(e){ console.warn('ui-fx scrollIn', e); }
    try { initNumberRoll(); } catch(e){ console.warn('ui-fx numberRoll', e); }
    try { initShortcuts(); }  catch(e){ console.warn('ui-fx shortcuts', e); }
    try { initToast(); }      catch(e){ console.warn('ui-fx toast', e); }
    document.documentElement.classList.add('ui-fx-on');
  });
})();
