# Fase 1 — Bloqueantes de tienda

Cosas que **hay que resolver antes de publicar** en Google Play / App Store.
Algunas dependen de decisiones y acciones del dueño (crear cuentas, elegir Auth vs
gateway, correr SQL); otras se pueden adelantar como código/borrador.

Estado global: 🟡 **en curso** — 1.2, 1.3 y 1.4 adelantados en su parte autónoma;
1.1 pendiente (decisión del dueño).

Commits: `582c94e` (0.6b, no de esta fase) · `e5335de` (1.3 + 1.4) · `6ee9333` (1.2).

---

### 1.1 — Autorización en el servidor + rotar claves     — ⬜ pendiente (dueño)

- **Problema:** el login es 100 % cliente (`CREDENCIALES_PERSONAL` con correos y
  contraseñas dentro del bundle → en un `.apk` se extrae con `strings`/`apktool`).
  + anon key pública + RLS abierta. Ver [[../INFORME-AUDITORIA-2.md]].
- **Qué falta (decisión del dueño):** adoptar **Supabase Auth** (recomendado) o una
  **Edge Function gateway**; luego rotar la anon key y todas las contraseñas.
- **Bloqueado para Claude:** requiere activar proveedor de Auth en el dashboard,
  crear cuentas, y rehacer el login de `app.js`. La `Edge Function eliminar-cuenta`
  (ver 1.4) ya está escrita como plantilla que encajará cuando exista Auth.

---

### 1.2 — Sincronización offline con resolución de conflictos   [2026-09-06]  🟡 código hecho · falta correr SQL

- **Problema:** `fusionarPorId` hacía "la remota siempre gana" → dos dispositivos
  (admin + chofer) editando el mismo pedido el mismo día se pisaban **sin aviso**
  al reconectar. Grave en móvil (más dispositivos, más cortes).
- **Qué se hizo (cliente, `app.js`):**
  - `sellarCambios()`: al guardar, re-sella `updatedAt` (ISO-8601) **solo** en la
    fila cuyo contenido cambió respecto a la última vez (firma con
    `stringifyEstable`, ignorando el propio `updatedAt`). Chokepoint único en
    `guardarPedidos` / `guardarGastos` — así el sello refleja de verdad "cuándo se
    tocó por última vez".
  - `pedidoARemoto` / `gastoARemoto` llevan `updated_at`; `pedidoDesdeRemoto` /
    `gastoDesdeRemoto` lo leen.
  - **`fusionarPorId`**: si un id está en ambos lados y ambos tienen `updatedAt`
    distinto → gana el **más reciente**. Si falta el sello en alguno → gana la
    remota (comportamiento anterior, **sin regresión**). `console.info` con el
    conteo de conflictos resueltos.
  - **feature-detect `soportaUpdatedAt`** en `iniciarSupabase`
    (`select updated_at limit 1`): si la BD todavía **no** tiene la columna,
    `conUpdatedAt()` la omite del payload → el mismo código funciona **antes y
    después** de correr la migración (PostgREST rechaza columnas desconocidas y
    tumbaría el upsert entero).
- **SQL (`supabase_schema.sql`, lo corre el dueño):**
  `alter table pedidos/gastos add column if not exists updated_at timestamptz not
  null default now()` + `function tocar_updated_at()` + triggers
  `before update` (una escritura directa por REST no puede **retroceder** el reloj
  de una fila).
- **Archivos:** `app.js`, `app.min.js`, `supabase_schema.sql`.
- **Commit:** `6ee9333`
- **Verificación:** en Chrome — app carga con los cambios; `updatedAt` sellado en
  las 19 filas al guardar; sin errores. La resolución de conflictos entre
  dispositivos se activa del todo cuando el dueño corre la migración (hasta
  entonces `soportaUpdatedAt=false` y se comporta como antes).
- **Pendiente:** correr `supabase_schema.sql` (bloque `updated_at`). Mejora futura:
  merge por campo en vez de por fila, y un panel visible de "última sincronización
  / conflictos".

---

### 1.3 — Política de privacidad                         [2026-09-06]  🟡 borrador hecho · falta completar y validar

- **Qué se hizo:** `privacidad.html` — página standalone en `/privacidad.html`,
  en **español**, referida a la **Ley N.º 29733** del Perú. Cubre: responsable,
  datos tratados y finalidad (clientes finales / personal / operativos / ubicación)
  con base legal, encargados (Supabase + Vercel) y **transferencia internacional**,
  OpenStreetMap/Nominatim, almacenamiento local, conservación, derechos (acceso,
  rectificación, cancelación, oposición) + Autoridad Nacional, eliminación de
  cuenta, seguridad, menores, cambios y contacto.
  - **9 campos `[COMPLETAR]`** para que el dueño rellene: nombre/razón social,
    dirección, correo de contacto (×varios), región de Supabase, plazos de
    conservación.
- **Enlaces:** en el pie de Inicio (accesible **sin login** — lo exige Apple) y en
  Ajustes → "Tu cuenta".
- **Archivos:** `privacidad.html`, `index.html`.
- **Commit:** `e5335de`
- **Verificación:** sirve 200 en local y en prod (`/privacidad.html`).
- **Pendiente:** el dueño completa los `[COMPLETAR]` y lo valida con un asesor
  legal peruano antes de enviar a tiendas.

---

### 1.4 — Borrado de cuenta                              [2026-09-06]  🟡 UI + web + plantilla hechos · falta la Edge Function real (depende de 1.1)

- **Qué se hizo:**
  - `eliminar-cuenta.html` (`/eliminar-cuenta.html`): página web con las dos vías
    (dentro de la app / por correo). **Ambas tiendas exigen el enlace web.**
    3 campos `[COMPLETAR]` (correo).
  - **Ajustes → "Eliminar mi cuenta"** (`renderEliminarCuenta` en `app.js`):
    visible para cualquier personal con sesión; checkbox de confirmación + `confirm()`;
    borra de **este dispositivo** las claves `kunturmasha_*` / `sedeCentral_*` de
    acceso y preferencias (**NO** `sedeCentral_pedidos_v1` ni `_gastos_v1` = son
    contabilidad de la empresa) y cierra sesión.
  - `supabase/functions/eliminar-cuenta/index.ts`: **plantilla** de la Edge
    Function (verifica el JWT del usuario, desliga sus registros de negocio,
    borra su perfil y su usuario de Auth con `service_role`). **No desplegada** —
    encaja cuando exista Supabase Auth (1.1).
  - Enlaces a ambas páginas en el pie de Inicio y en Ajustes.
- **Archivos:** `eliminar-cuenta.html`, `index.html`, `app.js`,
  `supabase/functions/eliminar-cuenta/index.ts`.
- **Commit:** `e5335de`
- **Verificación:** en Chrome — panel visible con sesión, botón bloqueado hasta
  marcar la confirmación; enlaces presentes en el pie. Página web sirve 200.
- **Pendiente:** correo de contacto en los `[COMPLETAR]`; y, tras 1.1, desplegar la
  Edge Function y conectarla al botón de Ajustes para el borrado server-side real.

---

## Pendiente de Fase 1 (resumen)

| Ítem | Quién |
|---|---|
| Elegir Supabase Auth vs Edge Function gateway + rehacer login + rotar claves | Dueño (decisión) + Claude (implementación) |
| Correr la migración `updated_at` de `supabase_schema.sql` | Dueño |
| Completar los `[COMPLETAR]` de `privacidad.html` y `eliminar-cuenta.html` y validar legalmente | Dueño |
| Desplegar la Edge Function `eliminar-cuenta` (tras Auth) | Dueño (o Claude si le dan acceso) |
