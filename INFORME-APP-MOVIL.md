# Informe — Convertir WaterCore Space en una app de celular

Fecha: 2026-09-06 · App: `https://kunturmasha.vercel.app` (estático en Vercel: `index.html` +
`app.js` ES5 ~282 KB + `ui-fx.*` + `vendor/leaflet` + `vendor/supabase-js`, Supabase
`mwvyhjvafwimcdxfyutf`, offline-first con `localStorage`).
Usuarios: personal de despacho de camiones cisterna en Trujillo — choferes con Android de
gama baja, administradores; uso en campo, señal intermitente, UI en español, maneja PII de
clientes (nombres, teléfonos, direcciones), precios y credenciales de personal.

Método: análisis del código propio + 3 investigaciones paralelas (modelo Fable) sobre
ruta PWA→tiendas, ruta Capacitor, y logística de tiendas + auditoría UX/rendimiento móvil.

---

## RESUMEN EJECUTIVO — la decisión

| Plataforma | Recomendación | Coste | Notas |
|---|---|---|---|
| **PWA (base, todas)** | **Hacerlo YA — Fase 0**. Es prerrequisito de todo lo demás y ya es útil hoy | 0 | ~2–3 días de dev: iconos PNG, manifest completo, `sw.js` mejorado, fixes de CSS móvil |
| **Android → Google Play** | **Sí. Capacitor con assets empaquetados** (no TWA de solo-URL, no `server.url`) + canal OTA para parches rápidos | 25 USD único | Preserva el offline-first, da plugins nativos, y **abre la puerta a iOS con el mismo proyecto**. Registrar la cuenta de Play como **organización** (D-U-N-S) para saltarse el gate de "12 testers × 14 días" |
| _Alternativa Android_ | TWA con Bubblewrap (carga la web en vivo de Vercel) | 25 USD único | Cero código nativo que mantener, pero **solo Android**, exige `assetlinks.json` + Lighthouse ≥ 80 + `offline.html` que devuelva 200, y depende de que Vercel esté vivo |
| **iOS → App Store** | **No por ahora**. PWA "Añadir a inicio" + guía para los pocos iPhone (administradores) | 0 | Empaquetar iOS exige Mac + Xcode 26 + Apple Developer 99 USD/año + riesgo de rechazo por Guideline 4.2. PWABuilder-iOS **fue archivado** (sep-2025). Cuando haga falta → `npx cap add ios` sobre el mismo proyecto Capacitor |
| **Push** | Web Push (VAPID) para la PWA + FCM para Capacitor, disparado por Edge Function de Supabase | 0 | La doc oficial de Supabase solo cubre FCM/Expo; hay que implementar web-push en Deno |

### Bloqueantes que hay que resolver ANTES de publicar en tiendas (no son opcionales)

1. **Seguridad de la autenticación.** Hoy el login es 100 % cliente: `CREDENCIALES_PERSONAL`
   (correos + contraseñas) va dentro de `app.js`. En un `.apk`/`.ipa` esas cadenas se
   extraen con `strings`/`apktool` en segundos. Además la anon key + RLS abierta = cualquiera
   con la app lee/escribe toda la base. Publicar una app con PII de clientes y este modelo
   es un problema de **cumplimiento**, no solo técnico: en el cuestionario *Data Safety*
   (Play) y *App Privacy* (Apple) tendrás que declarar "cifrado" y no lo es.
   → **Migrar a Supabase Auth o Edge Function gateway + rotar la anon key y las contraseñas.**
   (Ver [[INFORME-AUDITORIA-2]] y el bloque final de `supabase_schema.sql`.)
2. **Política de privacidad** en una URL pública (en español, ley peruana N.º 29733) —
   **ambas tiendas la exigen**. La app hoy no tiene ninguna.
3. **Borrado de cuenta in-app + página web** — Apple (Guideline 5.1.1(v)) y Google Play lo
   exigen para toda app con creación de cuenta.
4. **Integridad de datos offline.** La sync local↔Supabase es *last-write-wins* por `id`
   (`fusionarPorId`), sin control de conflictos. Dos dispositivos editando el mismo día =
   pérdida silenciosa de cambios al reconectar. Grave en móvil. → `updated_at`/`rev` por
   fila + resolución de conflicto explícita, o serializar escrituras en un gateway.

---

## PARTE 1 — Estado actual del código (qué tiene bien / mal para ser app)

### 1.1 Lo que YA está bien

- **PWA base funcional**: `manifest.webmanifest`, `sw.js`, botón "Instalar app"
  (`beforeinstallprompt`), `viewport-fit=cover`, `theme-color`. Se puede "Añadir a inicio"
  hoy en Android e iOS y arranca en `standalone`.
- **Offline real de datos**: toda la lógica corre con `localStorage`; Supabase es solo
  sincronización *best-effort*. Base correcta para campo con señal intermitente.
- **Service worker sensato**: network-first para el código (`index.html`/`app.js`/`ui-fx`),
  cache-first + revalidación para `vendor/`, **nunca cachea la API de Supabase**.
- **Responsive**: `@media` a 480/640/720/860 px, una columna en móvil, tabla con overflow,
  tira de pestañas con scroll horizontal.
- **Táctil parcial**: bajo `@media (pointer:coarse)`, 44×44 en `.btn-icon` y `min-height:44px`
  en `.filter-btn/.chip/.day-chip/.view-tab/.sub-tab/.btn-mini`.
- `-webkit-tap-highlight-color:transparent`, `prefers-reduced-motion` respetado en toda la
  capa de animación.
- **Dependencias auto-hospedadas** (Leaflet, supabase-js) → menos superficie de red y CSP
  ya estricta.

### 1.2 Lo que falta o está mal — priorizado

| # | Ítem | Por qué importa en móvil | Gravedad |
|---|---|---|---|
| **A** | **Iconos: solo `icon.svg` con `sizes:"any"`** | Hay un bug de Chromium (`crbug 40925759`): *instalar una PWA falla si un icono SVG tiene `sizes="any"`* — que es exactamente este caso. iOS ignora SVG (usa `apple-touch-icon` PNG 180). PWABuilder/Bubblewrap/Capacitor escalan el icono de Android **desde un PNG cuadrado grande**. | 🔴 Bloqueante de instalabilidad y de empaquetado |
| **B** | **Seguridad de auth / anon key** (ver Bloqueantes) | En binario, credenciales extraíbles. Contradice lo que declararás en Data Safety. | 🔴 |
| **C** | **Sync offline *last-write-wins*** sin conflictos | 2 dispositivos, mismo día → pérdida silenciosa. | 🔴 |
| **D** | **`viewport-fit=cover` puesto pero CERO `env(safe-area-inset-*)`** | En `standalone`/wrapper no hay barra del navegador: la cabecera y la barra de pestañas (`sticky; top:12px`) quedan **bajo el notch/barra de estado**, y el pie bajo el *home indicator*. | 🟠 |
| **E** | **Inputs con `font-size < 16px`** (`0.9rem`, `0.85rem`, `0.8rem`) | iOS Safari/WKWebView **hace zoom automático** al enfocar y no vuelve a alejar. Formulario "Despacho" = muchos campos. | 🟠 |
| **F** | **`body{min-height:100vh}` y `.modal{max-height:88vh}`, sin `dvh/svh`** | `100vh` en móvil es inestable con el chrome del navegador y el teclado → saltos y modales cortados. `dvh/svh/lvh` son *Baseline widely available* desde jun-2025. | 🟠 |
| **G** | **Táctil incompleto**: tarjetas de pedido con **hasta 6 botones-icono en fila** (`⬆ ⬇ ✎ ⏰ ✕ ↩ 🗑`), `.empresa-switch select` (~26 px), `input[type=date]` (~30 px), borrar fila en tablas | Apple 44 pt / Material **48 dp**. Chofer con una mano, al sol, en movimiento → toques errados. | 🟠 |
| **H** | **`app.js` 282 KB sin minificar** + aurora de fondo (`fxAurora 34s`, `fxSpin 90s`) y blob **siempre animando** + 4 `MutationObserver` + `backdrop-filter` en cada `.stat-tile` | En Android de gama baja: TBT alto al arrancar (1–3 s de hilo bloqueado), repaints/compositing continuos, batería/calor. Roza "Broken Functionality" de Play si va lento. | 🟠 |
| **I** | **Botón "atrás" de Android** no manejado (SPA que hace `hidden` en `<section>`) | "Atrás" cierra la app de golpe en vez de cerrar un modal / volver de vista → pérdida de trabajo. | 🟠 |
| **J** | **Casi cero `inputmode`/`enterkeyhint`/`autocomplete`**; teléfonos son `type="text"` | Teclado alfabético completo para teléfono, cantidad, precio, m³. | 🟡 |
| **K** | **Sin `overscroll-behavior`** | *Pull-to-refresh* accidental recarga la app y **pierde el formulario a medio llenar**; *scroll chaining* de listas internas. | 🟡 |
| **L** | **Manifest incompleto**: sin `id`, sin `screenshots` (con `form_factor`), shortcuts sin icono, sin `launch_handler`/`display_override` | Prompt de instalación mínimo en Android; identidad de PWA frágil entre updates. | 🟡 |
| **M** | **`sw.js`**: `skipWaiting()` incondicional (*version skew* a media sesión), sin navigation preload, sin `offline.html` de último recurso, sin `navigator.storage.persist()`, sin poda LRU | Arranque más lento por navegación en gama baja; riesgo de perder la cola offline si el SO expulsa storage. | 🟡 |
| **N** | **PII en `localStorage` en claro** | Teléfono del chofer perdido/robado (habitual en campo) → PII trivialmente accesible. | 🟠 |
| **O** | **Fuentes Google Fonts desde CDN** | Sin señal, cae a fuente del sistema (no rompe, solo estética). Para offline 100 %: auto-hospedar como Leaflet. | 🟢 |
| **P** | **Reverse-geocoding contra Nominatim** directo (`app.js` ~3475) | Política de uso estricta (1 req/s, `User-Agent` propio); desde `capacitor://localhost` el `Referer` es raro → puede bloquear. Enrutar por Edge Function proxy con caché. | 🟡 |

---

## PARTE 2 — Las rutas, comparadas

### Ruta A — PWA a nivel de producción (base de todo)
Arreglar A, D–M, O. ~2–3 días. **Resultado:** PWA instalable de calidad, ya utilizable hoy
vía "Instalar app" en Android, y "Añadir a inicio" en iOS. Es prerrequisito de B y C.

### Ruta B — Android en Google Play

| | **B1: TWA (Bubblewrap)** | **B2: Capacitor (assets empaquetados)** ✅ |
|---|---|---|
| Qué es | App Android que abre tu PWA **en vivo desde Vercel** en pantalla completa | App Android real con `index.html`+`app.js`+`vendor/` **dentro del binario**; el WebView los sirve local y `app.js` habla con Supabase |
| Código nativo a mantener | **Ninguno** (solo re-`build` si cambias icono/nombre) | El shell + plugins (poco, pero existe) |
| Offline desde el primer arranque | Solo si `offline.html` devuelve **HTTP 200** (si no, Chrome 86+ **crashea el TWA**) | **Sí, siempre** |
| Sirve para iOS | **No** | **Sí** (mismo proyecto, `npx cap add ios`) |
| Requisitos extra | `assetlinks.json` con 2 huellas SHA-256, Lighthouse móvil ≥ 80, PWA viva en Vercel | Firebase para push, `Info.plist` (iOS), plugins |
| Arreglos rápidos de HTML/JS | Instantáneos (es la web de Vercel) | Release de tienda **o** canal OTA (Capgo/Capawesome) sin revisión |
| Riesgo de rechazo | Bajo si el dominio es tuyo (`assetlinks.json` lo prueba) y hay valor offline | Bajo (hay capa nativa real); evitar el "wrapper vago" |

**Recomendación: B2 (Capacitor).** Preserva el offline-first sin depender de que Vercel/Chrome
estén disponibles, da plugins nativos (geoloc, share/filesystem para el CSV, push), y **el
mismo proyecto sirve para iOS después**. El coste (parches por release) se neutraliza con un
canal OTA. B1 es válido si **nunca** se va a querer iOS y se prioriza cero mantenimiento nativo.

### Ruta C — iOS en App Store
Solo con **Capacitor** (PWABuilder-iOS archivado en sep-2025; `WKWebView` tiene el service
worker con bugs que **romperían el offline-first**). Necesita **Mac + Xcode 26 + Apple
Developer 99 USD/año**, `PrivacyInfo.xcprivacy`, y superar Guideline 4.2 ("no es solo una
web": ubicación nativa, `tel:`, abrir dirección en Mapas, funciona offline, push).
**Diferido** hasta que haya demanda real de iPhone; mientras tanto, guía de "Añadir a inicio"
para los administradores con iPhone (recordando que **hay que instalarla**: si se usa como
pestaña de Safari, iOS **borra `localStorage` a los ~7 días de uso de Safari sin
interacción** → se pierde la cola offline).

---

## PARTE 3 — Paso a paso (fases)

### FASE 0 — Endurecer la PWA  *(empezamos por aquí)*

| Paso | Detalle |
|---|---|
| **0.1** | **Iconos PNG.** Generar `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png` (contenido dentro del 80 % central), `apple-touch-icon.png` (180, sin alfa, fondo `#dceffb`), `shortcut-agenda/hub/despacho.png` (96). Quitar `sizes:"any"` del SVG o retirar el SVG de `icons`. |
| **0.2** | **Manifest completo**: `id`, `start_url` con traza, `display_override`, `launch_handler:{client_mode:"navigate-existing"}`, `handle_links:"preferred"`, `screenshots` con `form_factor` narrow/wide, iconos en `shortcuts`, set PNG en `icons`. Metas `apple-mobile-web-app-*` + `apple-touch-icon` en `index.html`. |
| **0.3** | **`sw.js` v5**: quitar `skipWaiting()` automático + flujo "nueva versión → recargar" en `pwa.js`; `navigationPreload.enable()` en `activate`; `offline.html` mínima (sin `app.js`) que devuelva 200 como último recurso; poda LRU (~60 entradas) en el caché de runtime; `navigator.storage.persist()` en `pwa.js`. |
| **0.4** | **CSS móvil**: `env(safe-area-inset-*)` en `body`, cabecera y `.view-tabs`; `font-size:16px` en inputs bajo `@media (pointer:coarse)`; `100svh`/`100dvh` con fallback; ampliar `@media (pointer:coarse)` a **48 px** e incluir `select`, `input[type=date]`, acciones de fila; `overscroll-behavior-y:none` en `html,body` + `contain` en contenedores scrollables; `@media (hover:hover)` alrededor de los efectos `:hover`; `user-select:none` en botones/tabs (texto seleccionable en celdas de datos). |
| **0.5** | **Formularios**: `inputmode` (`tel`/`decimal`/`numeric`) + `enterkeyhint` + `autocomplete` en los campos; `scrollIntoView({block:'center'})` en `focus`. |
| **0.6** | **Rendimiento**: minificar `app.js`/`ui-fx.js` en el deploy; pausar aurora/blob con `document.visibilitychange` y en `deviceMemory<=4`/`hardwareConcurrency<=4`; `content-visibility:auto` en filas/tarjetas fuera de pantalla; `{passive:true}` en listeners de scroll/touch; lazy-init de Leaflet al abrir el mapa. Toggle "Modo ligero" en Ajustes. |
| **0.7** | **Botón atrás / historial**: `history.pushState` por vista + `popstate` (para navegador **y** para el listener `App.backButton` de Capacitor luego). |
| **0.8** | Auto-hospedar las fuentes en `vendor/fonts/` y quitarlas de la CSP (offline 100 %). |
| **0.9** | Lighthouse móvil (perfil Moto G, Slow 4G): **Performance ≥ 80** (obligatorio si algún día se va por TWA), TBT < 200 ms, "Tap targets" y "Content sized to viewport" en verde. Probar en un Android real de gama baja. |
| **0.10** | Subir `public/.well-known/assetlinks.json` (placeholder; se completa en Fase 1 si se hace TWA). |

### FASE 1 — Prerrequisitos de tienda (en paralelo a Fase 0)

| Paso | Detalle |
|---|---|
| **1.1** | **Seguridad**: adoptar **Supabase Auth** (o Edge Function gateway) para el login del personal; rotar la anon key y todas las contraseñas de `CREDENCIALES_PERSONAL`. Mover PII sensible de `localStorage` a almacenamiento cifrado del SO (`@capacitor/preferences` sobre Keychain/Keystore) en la versión app. |
| **1.2** | **Conflictos offline**: `updated_at` + `rev` por fila; en el push `UPDATE ... WHERE rev = :rev_local`; si falla → conflicto explícito al usuario. Cola *outbox* con `client_op_id` idempotente. Log de sincronización visible. |
| **1.3** | **Política de privacidad** en `kunturmasha.vercel.app/privacidad` (ES, ley 29733, qué datos, Supabase como encargado + transferencia internacional, conservación, derechos, contacto, fecha). |
| **1.4** | **Borrado de cuenta**: pantalla "Ajustes → Eliminar mi cuenta" (confirma → Edge Function con `service_role` borra/anonimiza → cierra sesión) + página `kunturmasha.vercel.app/eliminar-cuenta`. |
| **1.5** | **Cuentas de desarrollador**: Google Play **como organización** (D-U-N-S de la empresa cisterna → evita el gate de 12 testers/14 días), 25 USD único. Apple Developer 99 USD/año **solo si** se va a hacer iOS. Empezar el alta ya (D-U-N-S tarda 1–4 semanas). |

### FASE 2 — Empaquetar Android con Capacitor

| Paso | Detalle |
|---|---|
| **2.1** | `npm init -y`; `npm i @capacitor/core@latest`; `npm i -D @capacitor/cli@latest`. |
| **2.2** | `scripts/build-www.mjs` que copia `index.html, app.js, ui-fx.*, pwa.js, manifest.webmanifest, icons/, vendor/` → `www/`. `.gitignore` += `www/ node_modules/`. |
| **2.3** | `npx cap init "WaterCore" "pe.kunturmasha.watercore" --web-dir www`. `capacitor.config.ts` (androidScheme `https`, SplashScreen `#dceffb`, StatusBar `LIGHT`, **`CapacitorHttp` NO habilitado** — rompe websockets). |
| **2.4** | `npm i @capacitor/android@latest` → `npx cap add android` → `npm run build:www && npx cap sync`. |
| **2.5** | **CSP de `www/index.html`** (la única que aplica en nativo — `vercel.json` es irrelevante dentro del binario): añadir `blob: https://localhost capacitor://localhost` a `img-src` y `connect-src`; **mantener** los hosts de Supabase (http+wss) y Nominatim (`'self'` NO los cubre). |
| **2.6** | Plugins: `npm i @capacitor/app @capacitor/geolocation @capacitor/share @capacitor/filesystem @capacitor/network @capacitor/preferences @capacitor/status-bar @capacitor/splash-screen @capacitor/keyboard`. |
| **2.7** | Cambios en `app.js` (guard `isNative`/`Capacitor.Plugins`): (a) `descargarArchivo()` → rama nativa con Filesystem+Share (el `<a download>` **no funciona en WebView**); (b) `App.backButton` → cerrar modal / volver de vista / `exitApp`; (c) `App.appUrlOpen` + `getLaunchUrl` para deep links `?vista=`; (d) re-suscribir realtime en `App 'resume'` y `Network 'networkStatusChange'`; (e) `btnUbicacionActualHub` → `@capacitor/geolocation`; (f) espejo a `@capacitor/preferences` de sesión/empresa/afiliaciones. |
| **2.8** | Iconos/splash: `npx @capacitor/assets generate --iconBackgroundColor '#dceffb' --splashBackgroundColor '#dceffb'`. |
| **2.9** | `keytool` → keystore (guardar en `.boveda`, nunca en el repo); `key.properties`; `signingConfigs.release`. `targetSdk 36` (Cap 8 ya). Generar `.aab` firmado. Probar `.apk` en un móvil de chofer real, **en modo avión** (debe abrir y funcionar). |
| **2.10** | Play Console: ficha (descripción, ≥ 2 screenshots de teléfono, icono 512, **feature graphic 1024×500**), política de privacidad (URL), cuestionario **Data Safety** coherente, clasificación IARC. Enviar a revisión. |
| **2.11** | Canal **OTA** (`@capgo/capacitor-updater` o Capawesome) para parchear `app.js`/HTML en campo sin pasar por revisión. |

### FASE 3 — Push notifications

| Paso | Detalle |
|---|---|
| **3.1** | PWA: claves VAPID; tabla `push_subscriptions` (RLS por usuario); `pwa.js` con botón "Activar avisos" (gesto), `pushManager.subscribe`, handlers `push`/`notificationclick` en `sw.js`, `pushsubscriptionchange`. |
| **3.2** | Capacitor/Android: `npm i @capacitor/push-notifications`; proyecto Firebase → `google-services.json`; canal `trabajos` (importance alta); tabla `push_tokens`. |
| **3.3** | Edge Function `push` (Deno + `google-auth-library` → FCM HTTP v1 con la cuenta de servicio como secreto). Database Webhook sobre `INSERT` de pedido/solicitud → llama a `push`. |
| **3.4** | (iOS, si se hace) capability Push + Background Modes; clave APNs `.p8` en Firebase; callbacks en `AppDelegate.swift`. |

### FASE 4 — iOS (diferido; solo si hay demanda)
`npx cap add ios` sobre el mismo proyecto; `NSLocationWhenInUseUsageDescription` +
`PrivacyInfo.xcprivacy`; Xcode 26 en Mac; TestFlight → App Store. Preparar respuesta a
Guideline 4.2. Mientras tanto: tarjeta en `index.html` que detecta iOS y muestra los 3 pasos
de "Compartir → Añadir a pantalla de inicio".

---

## PARTE 4 — Logística de tiendas (referencia)

### Costes
| Concepto | Coste |
|---|---|
| Google Play Console | **25 USD** pago único (no anual) |
| Apple Developer Program | **99 USD/año** (solo si se hace iOS) |
| D-U-N-S (cuenta de organización) | 0 USD, tarda 1–4 semanas |
| Mac para iOS | propio, o macOS en la nube ~20–100 USD/mes |
| Política de privacidad + página de borrado | 0 (en el propio Vercel) |
| Herramientas (Capacitor, Bubblewrap, `@capacitor/assets`) | 0 |
| OTA (Capgo/Capawesome) | 0–14+ USD/mes |
| **Mínimo realista año 1** | **~25 USD** (solo Android) · **~125 USD** (Android + iOS, con Mac propio) |

### Requisitos que muerden
- **Google Play, target API**: apps/updates nuevas desde **31-ago-2026 → API 36**. Capacitor 8 ya cumple.
- **Google Play, cuenta personal nueva (post 13-nov-2023)**: **12 testers opt-in continuo 14 días** con uso real, antes de poder pedir producción. **Cuenta de organización queda exenta** → registrar como organización.
- **Apple Guideline 4.2** ("minimum functionality"): rechazo si "es solo una web". Mitigación: assets empaquetados (no `server.url`), funciones nativas reales, valor offline demostrado en las notas de revisión.
- **Ambas**: política de privacidad (URL pública) + borrado de cuenta in-app y web + cuestionario de privacidad coherente con lo que Supabase almacena + clasificación de contenido.
- **Apple**, desde 1-may-2024: `PrivacyInfo.xcprivacy` con "required reason APIs" (UserDefaults `CA92.1`, FileTimestamp `C617.1`, DiskSpace `E174.1`) — su ausencia = rechazo automático.

### Activos de tienda
- Icono: Apple 1024×1024 PNG sin alfa; Play 512×512 PNG con alfa + adaptativo.
- Capturas: Apple 6.9" 1320×2868 (mín.); Play ≥ 2 de teléfono, 1080×1920.
- **Play**: feature graphic **1024×500** obligatorio.

### Cronograma realista
- Fase 0 (PWA): **1–2 semanas**.
- Alta de cuentas: 2 días (Apple individuo) – 4 semanas (organización + D-U-N-S). **Empezar ya.**
- Empaquetado Capacitor + cambios de código + assets: **1–2 semanas**.
- Google closed testing (si cuenta personal): **≥ 14 días de calendario**.
- Revisiones: Google 1–7 días (cuenta nueva); Apple 24–48 h típico, **prever 1–2 rechazos por 4.2** (+3–7 días cada ciclo).
- **Total a ambas tiendas: 6–10 semanas**, dominado por verificación de cuentas, el gate de testing y los ciclos de rechazo de Apple. El envoltorio Capacitor en sí son **1–3 días**.

---

## Notas de versión (a fecha del informe)
- Capacitor vigente: **8.5.x** (no 7). Node ≥ 22, Android Studio Otter 2025.2.1+, JDK 21,
  `minSdk 24`, `compile/targetSdk 36`, Xcode 26 / iOS 15, **SPM por defecto** en iOS.
- Ionic Appflow (OTA) está en cierre (EOL 31-dic-2027) → usar **Capgo** o **Capawesome**.
- PWABuilder-iOS: repo **archivado** (11-sep-2025), soporte "community driven".

---

_Detalle completo de cada investigación: transcripciones de los 3 agentes (Fable) de esta
sesión. Siguiente acción: **Fase 0, paso 0.1 — generar el set de iconos PNG + manifest
completo.**_
