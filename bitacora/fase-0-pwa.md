# Fase 0 — Endurecer la PWA

Objetivo: dejar la PWA a nivel de producción (instalable, offline, apta para móvil)
como base de la Fase 2 (Capacitor). Ver plan en `../INFORME-APP-MOVIL.md` §Parte 3.

Estado global: 🟡 **en curso** — 0.1–0.9 hechos y desplegados; 0.2 (capturas reales)
y 0.6-minificación diferidos.

Commits de esta fase (rama `master`):

| Commit | Pasos |
|---|---|
| `dcb4ab4` | 0.1 + 0.3 |
| `5c5f83b` | 0.4 + 0.5 + 0.7 |
| `4439a15` | 0.6 (parte segura) + 0.8 |
| `06f2d87` | 0.9 (Lighthouse) |
| `0d4c526` | docs (estado-proyecto) |

---

### 0.1 — Set de iconos PNG + manifest completo        [2026-09-06]  ✅ hecho · desplegado

- **Qué se hizo:**
  - Generados con `sharp` desde `icon.svg` / `icons/icon-maskable.svg`:
    `icons/icon-192.png`, `icon-512.png`, `icon-maskable-192.png`,
    `icon-maskable-512.png` (contenido al 66 % en zona segura),
    `apple-touch-icon.png` (180, **sin alfa**), y 3 iconos de shortcut 96×96
    (`shortcut-agenda/hub/despacho.png`).
  - `manifest.webmanifest` reescrito: `id`, `start_url` con traza, `display_override`,
    `launch_handler: navigate-existing`, `handle_links: preferred`,
    `prefer_related_applications: false`, `screenshots` (narrow/wide),
    iconos en los 3 `shortcuts`, set PNG en `icons` (+ SVG como extra sin `sizes:"any"`).
  - `index.html <head>`: `apple-touch-icon` → PNG; `<link rel="icon">` PNG 192/512;
    `mobile-web-app-capable`.
- **Por qué:** el icono SVG con `sizes:"any"` disparaba el bug de Chromium
  `crbug 40925759` (instalación de PWA falla). iOS ignora SVG. PWABuilder/Bubblewrap/
  Capacitor exigen PNG cuadrado grande.
- **Archivos:** `icons/*` (nuevos), `manifest.webmanifest`, `index.html`, `sw.js`
  (precache), `vercel.json` (cache `/icons/`).
- **Commit:** `dcb4ab4`
- **Verificación:** en prod `manifest.webmanifest` → `id` presente, 5 iconos, PNG
  192+512 + maskable OK. Todos los `/icons/*.png` responden 200.
- **Pendiente:** `screenshots/*` son **placeholders de marca**; sustituir por
  capturas reales tras 0.4 (ver 0.2).

---

### 0.2 — Capturas reales para el manifest              [2026-09-06]  ⬜ pendiente

- **Bloqueo:** el navegador de captura de este entorno devuelve error "0 width"
  al hacer screenshot. Los `screenshots` del manifest apuntan a placeholders
  (`screenshots/movil-agenda.png`, `movil-despacho.png`, `escritorio-hub.png` —
  1080×1920 / 1920×1080, generados con `sharp`).
- **Qué falta:** 3 capturas reales de la UI (agenda del chofer, alta de despacho,
  Hub) a 1080×1920 (narrow) y una wide 1920×1080. Chrome las usa en el diálogo de
  instalación enriquecido; su ausencia no rompe la instalabilidad.
- **Cómo:** hacerlas a mano en un teléfono/emulador, o en CI, y reemplazar los
  archivos manteniendo los nombres.

---

### 0.3 — `sw.js` v6 + `pwa.js`                          [2026-09-06]  ✅ hecho · desplegado

- **Qué se hizo:**
  - `sw.js`: quitado `skipWaiting()` automático del `install` (evita *version skew*
    — código viejo recibiendo assets nuevos a media sesión); lo dispara el aviso
    "nueva versión" de `pwa.js` vía `postMessage`.
  - `navigationPreload.enable()` en `activate` (−100–400 ms por navegación en gama
    baja).
  - `offline.html` mínima (sin `app.js`) que **devuelve 200** — último recurso en
    el handler de navegación (importante para que un TWA no crashee).
  - Poda LRU (`RUNTIME_MAX = 60`) del caché de runtime.
  - `pwa.js`: `navigator.storage.persist()` (que el SO no expulse la cola offline)
    + `register(..., { updateViaCache: 'none' })`.
  - `CACHE_VERSION` → `wcs-v5` (luego `wcs-v6` en 0.8).
- **Archivos:** `sw.js`, `pwa.js`, `offline.html` (nuevo), `vercel.json`
  (cache `/offline.html`).
- **Commit:** `dcb4ab4`
- **Verificación:** `offline.html` sirve 200, renderiza (título, botón "Reintentar"
  como `<a>` — sin `onclick` inline por la CSP). App carga sin errores en Chrome.

---

### 0.4 — CSS móvil / app                               [2026-09-06]  ✅ hecho · desplegado

- **Qué se hizo** (bloque `FASE 0.4` al final del `<style>`, aditivo, solo táctil):
  - `env(safe-area-inset-*)` en `body` (padding en las 4 direcciones con `max()`)
    y en `.view-tabs` (`top: calc(12px + env(safe-area-inset-top))`).
  - `@media (pointer:coarse)`: **`font-size:16px`** en todos los controles de
    formulario (mata el zoom automático de iOS al enfocar). Objetivos táctiles a
    **48px** (`.filter-btn/.chip/.day-chip/.view-tab/.sub-tab/.btn-mini/.btn-icon`,
    `select`, `input[type=date|time]`, `empresa-switch select`, `#rolSwitcher`,
    `.btn-logout`, `.rol-pill`). Más `gap` en `.order-actions`.
  - `overscroll-behavior-y:none` en `html,body` (mata el pull-to-refresh que
    recargaba y perdía el formulario) + `contain` en contenedores scrollables.
  - `@media (hover:none)`: neutraliza los `:hover` con `transform` que se quedaban
    pegados tras el tap + `:active` de respaldo (escala .96).
  - `user-select:none` + `-webkit-touch-callout:none` en botones/tabs/chips
    (el contenido de celdas de datos sigue seleccionable).
  - `body { min-height:100vh; min-height:100svh; }` (viewport estable).
- **Archivos:** `index.html` (`<style>`).
- **Commit:** `5c5f83b`
- **Verificación:** en Chrome, `overscroll-behavior-y = none`; reglas `FASE 0.4` y
  `env(safe-area)` parseadas; `getComputedStyle` de inputs. (El escritorio no cambia.)

---

### 0.5 — Pistas de teclado en formularios              [2026-09-06]  ✅ hecho · desplegado

- **Qué se hizo:** `inputmode` / `enterkeyhint` / `autocomplete` en:
  `telefono` (`tel`/`tel`/`next`), `precio` y `gastoMonto` (`decimal`/`done`),
  `volumenM3` y `fleteVolumen` (`decimal`), `detalleUbicacion` (`street-address`/`next`).
  En `app.js` (formulario del Hub, plantilla string): `hubCliente` (`name`/`next`),
  `hubTelefono` (`tel`/`tel`/`next`), `hubVolumen` (`decimal`), `hubDireccion`
  (`street-address`/`send`).
- **Archivos:** `index.html`, `app.js`.
- **Commit:** `5c5f83b`
- **Verificación:** atributos presentes en el DOM en Chrome (`telInputmode = tel`,
  `precioInputmode = decimal`).

---

### 0.6 — Rendimiento (parte segura)                    [2026-09-06]  🟡 parcial · desplegado

- **Qué se hizo:**
  - **Modo ligero** (`ui-fx.js` `initLite()` + CSS `html.fx-lite`): se activa si
    `navigator.deviceMemory <= 4` o `hardwareConcurrency <= 4` (o
    `localStorage.wcs_modo_ligero === '1'`). Apaga la aurora de fondo (`fxAurora`
    34 s), el giro (`fxSpin` 90 s), el `fxBreathe` del botón "Avanzar" y los
    `backdrop-filter` caros. API pública `window.wcsModoLigero(on)` para un toggle
    en Ajustes.
  - **Congelar en segundo plano** (`html.fx-paused` con `visibilitychange`):
    `animation-play-state: paused` en todo cuando la pestaña no se ve.
  - **`content-visibility:auto`** + `contain-intrinsic-size:0 240px` en
    `#timelineList > .order-card` (solo `pointer:coarse`), salvo la tarjeta en
    edición y las 6 primeras (LCP).
  - Verificado que los `pointermove` de magnetic/tilt de `ui-fx.js` **no se
    registran en táctil** (early-return por `pointer:coarse`) → 0 coste ahí en móvil.
- **Archivos:** `ui-fx.css`, `ui-fx.js`.
- **Commit:** `4439a15`
- **DIFERIDO a Fase 2:** minificar `app.js` (~282 KB) + `ui-fx.js` y code-splitting
  → con **esbuild** dentro de `scripts/build-www.mjs` al montar Capacitor.
  Objetivo Lighthouse Performance ≥ 80. (En prod ya va brotli a ~77 KB de
  transferencia; el problema restante es tiempo de *parse* en CPU lenta.)

---

### 0.7 — Botón "atrás" de Android / historial          [2026-09-06]  ✅ hecho · desplegado

- **Qué se hizo** (`app.js`):
  - `irAVista(nombre, desdePop)`: en cada cambio real de vista, `history.pushState(
    { v: nombre }, '', location.pathname + '?vista=' + nombre)`.
  - `window.addEventListener('popstate', …)`: 1º `cerrarModalesAbiertos()` — si
    cerró alguno, re-empuja un estado y no navega; 2º si no, `cancelarEdicion()` +
    `irAVista(estado.v ó defaultView del rol, true)`.
  - `history.replaceState({ v: vistaActual }, '')` al arrancar.
- **Por qué:** la app es una SPA que hace `hidden` en `<section>`s; sin esto, "atrás"
  cerraba la app de golpe. Es también la base del listener `App.backButton` de
  Capacitor (Fase 2).
- **Archivos:** `app.js`.
- **Commit:** `5c5f83b`
- **Verificación:** en Chrome — clic "Cotizar" → URL `?vista=cotizar`, `history`
  crece; `history.back()` → vuelve a `home`, URL `/`. `history.back()` con el modal
  de copia de seguridad abierto → **lo cierra sin navegar**.

---

### 0.8 — Fuentes auto-hospedadas                        [2026-09-06]  ✅ hecho · desplegado

- **Qué se hizo:**
  - Descargado el subset **latin** (cubre acentos y ñ) de Inter (400/500/600/700/800)
    e IBM Plex Mono (500/600/700) → `vendor/fonts/*.woff2` (8 archivos, ~286 KB) +
    `vendor/fonts/fonts.css` con `@font-face` locales. `_google.css` guardado como
    referencia del origen.
  - `index.html`: fuera el `<link>` a `fonts.googleapis.com` y los 2 `preconnect`;
    dentro `<link rel="stylesheet" href="/vendor/fonts/fonts.css">` + `preload` de
    `inter-400/700`.
  - **CSP** (meta de `index.html` + `vercel.json`): fuera `https://fonts.googleapis.com`
    de `style-src` y `https://fonts.gstatic.com` de `font-src` → `style-src 'self'
    'unsafe-inline'` y `font-src 'self'`.
  - 8 woff2 + `fonts.css` al **precache del SW**; `CACHE_VERSION` → `wcs-v6`.
- **Por qué:** offline 100 % de tipografía; menos dominios en la CSP; sin
  dependencia de red externa para el render.
- **Archivos:** `vendor/fonts/*` (nuevos), `index.html`, `vercel.json`, `sw.js`.
- **Commit:** `4439a15`
- **Verificación:** en prod `fonts.css` y woff2 → 200; CSP `font-src 'self'` sin
  gstatic; sin `<link>` a Google Fonts. 8 `@font-face` registrados (`document.fonts.size`).

---

### 0.9 — Lighthouse móvil (línea base)                  [2026-09-06]  ✅ hecho

- **Qué se hizo:** `npx lighthouse@12` contra `https://kunturmasha.vercel.app/`,
  `--form-factor=mobile`. Guardado en `auditorias/lighthouse-movil-20260906.{json,html}`.
- **Resultado:**
  - **Best Practices: 100** · **Performance: 65**
  - PASS: `viewport`, `font-size` (97 % legible — ayudó el cambio a 16px de 0.4),
    `uses-passive-event-listeners`, `errors-in-console`, `uses-text-compression`,
    `dom-size` (660).
  - FAIL: `unminified-javascript` (~26 KiB) → se resuelve en Fase 2.
  - Métricas: FCP 2.0 s · LCP 4.6 s · TBT 440 ms · CLS 0.149 · TTI 5.0 s.
  - "Avoid multiple page redirects — 4.8 s" es **artefacto del test** (cuenta el
    308 `http→https`; los usuarios reales entran por `https://`, y la PWA instalada
    usa `start_url` directa → 0 redirects; comprobado con `curl -IL`).
- **Commit:** `06f2d87`
- **Pendiente:** re-correr tras la minificación de Fase 2 y en un teléfono real de
  gama baja.

---

### Fix colateral — `Permissions-Policy`               [2026-09-06]  ✅ hecho · desplegado

- `vercel.json` tenía `Permissions-Policy: geolocation=()` (de la primera tanda de
  cabeceras de seguridad) → **bloqueaba** `navigator.geolocation`, es decir el botón
  "usar mi ubicación" del formulario del Hub. Cambiado a `geolocation=(self)`.
- **Commit:** `5c5f83b` · verificado en prod (`geolocation=(self)` en la cabecera).

---

### 0.10 — `assetlinks.json`                             — ⬜ solo si TWA

Placeholder no creado. Solo hace falta si al final se opta por **TWA/Bubblewrap**
en vez de **Capacitor** para Android. Con Capacitor no aplica.
