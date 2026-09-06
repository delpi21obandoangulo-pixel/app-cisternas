# Informe de Auditoría 2 — Auto-pentest y contramedidas

Fecha: 2026-09-06
Rama: `demo-sandbox`
Contexto: pruebas ofensivas contra la propia app (instancia local servida en
`localhost:4599` + la API real de Supabase **solo en modo lectura**), autorizadas por
el dueño del proyecto. Ninguna acción destructiva ejecutada contra datos reales.

---

## Resumen

| # | Ataque | Método | Resultado |
|---|---|---|---|
| 1 | Acceso directo a la API con la anon key pública | `curl` a `…/rest/v1` sin login | 🔴 **Éxito** — lectura total de todas las tablas |
| 2 | XSS almacenado | 20+ payloads en filas de `pedidos` | 🟢 **Bloqueado** por las correcciones del commit `18cb26a` |
| 3 | Escalada de privilegios en el cliente | Forja de sesión en `localStorage` | 🔴 **Éxito** — SuperAdmin sin contraseña |

Dos de los tres siguen abiertos porque son **arquitectónicos** (auth y autorización
viven en el navegador). No se pueden cerrar sin la decisión + acción del dueño
(Supabase Auth o Edge Function gateway). El XSS —lo único que dependía solo de código
de front— quedó cerrado y verificado.

---

## Ataque 1 — API REST con la anon key (autorización rota)

**Método.** La anon key `sb_publishable_Cazqtu…` está en el bundle. Sin ninguna sesión:

```
GET https://mwvyhjvafwimcdxfyutf.supabase.co/rest/v1/pedidos?select=*
    apikey: <anon key>          -> HTTP 206, Content-Range 0-0/20
```

**Resultado (medido).**

| Tabla | Filas leídas por un anónimo |
|---|---|
| `pedidos` | 20 (incluye nombre de cliente, dirección, teléfono, precio) |
| `gastos` | 9 |
| `solicitudes_centrales` | 3 (incluye teléfono del cliente) |
| `ofertas_subasta` | 3 |
| `config_empresas` | 0 (vacía hoy, pero legible) |

Ejemplo real devuelto: `{"id":"PED-04","cliente":"shimo cli-004","telefono":"",`
`"ubicacion":"Trujillo (Cercado), Centro Histórico, Av. del Ejercito…","precio":200.00}`.

La escritura/borrado anónimos **no se ejecutaron contra la base real** (por política de
no tocar datos de producción y por el bloqueo del clasificador), pero están igual de
abiertos: las políticas son `for all using(true) with check(true)` y hay
`grant insert, update, delete … to anon`. Es decir: un anónimo puede vaciar `pedidos`
con un solo `DELETE`.

**Impacto.** Fuga total de PII de clientes; manipulación/borrado de toda la operación;
adjudicarse solicitudes del Hub; alterar la política de pagos de cualquier empresa.

**Contramedida aplicada (parcial, mitigación).**
- `supabase_schema.sql` endurecido: `CHECK` de longitud/rango/enumerado + `no_html()` +
  triggers de throttle (limita corrupción masiva, flooding y tamaño de payload).
- Vista `solicitudes_publicas` que oculta el teléfono salvo cuando la solicitud está
  adjudicada (lista para activar del todo).
- **Pendiente del dueño (no lo puedo hacer yo):** Supabase Auth **o** Edge Function
  gateway + rotación de la anon key. Pasos exactos en el bloque final de
  `supabase_schema.sql` y en `INFORME-AUDITORIA.md` §6.

---

## Ataque 2 — XSS almacenado (BLOQUEADO)

**Método.** Con la base escribible por cualquiera (Ataque 1), el vector real es
insertar una fila con HTML en un campo de texto y esperar a que la agenda de un
administrador la pinte. Se probaron, inyectando en `localStorage` y recargando, 20+
payloads cubriendo distintos contextos y bypasses:

- `<img src=x onerror=…>`, `<svg onload=…>`, `<body onload=…>`
- Ruptura de atributo: `x" onmouseover="…" data-x="`
- `<iframe srcdoc="…">`, `<details open ontoggle=…>`
- `<math><mtext><script>…`, comillas invertidas `` <img src=`x`… ``
- `javascript:` en `href`, DOM clobbering (`<form id=document>`)
- Payload directo en `p.id`, `p.estado`, `p.tipoAlmacen`, `p.notas`, `p.codigoCliente`, etc.

**Resultado.** Ninguno ejecutó. Comprobado tras recargar:
- `__xssProof` en `localStorage`: **NONE** (ningún callback disparó).
- Elementos con atributo `on*` dentro de `#timelineList`: **0**.
- Elementos `<img>/<svg>/<iframe>/<script>` inyectados: **0**.
- El payload aparece como **texto inerte**: `<`, `>`, `"`, `'`, `` ` `` fueron
  eliminados por `sanText()` en el borde de datos, y lo que llega al DOM va por
  `escapeHtml()`.
- Aunque algo se colara, la CSP (`script-src` sin `'unsafe-inline'`, con `app.js`
  externo) impide ejecutar `<script>` inline y handlers `on*` — verificado: inyectar
  `document.createElement('script')` con `textContent` **no ejecuta**.

**Estado:** cerrado. Defensa en 3 capas (saneo en el borde + escape en el sink + CSP).

---

## Ataque 3 — Escalada de privilegios en el cliente

**Método.** Toda la autenticación está en `app.js`. Dos caminos:

1. **Leer las credenciales del bundle.** `app.js` es público; contiene
   `CREDENCIALES_PERSONAL` con correos y contraseñas en claro, incluida la cuenta
   `superAdmin: true, accesoGlobal: true` (`piero@watercorespace.pe`). Cualquiera que
   abra el fuente puede iniciar sesión como SuperAdmin.
2. **Forjar la sesión sin contraseña.** Ejecutado:
   ```js
   localStorage.setItem('kunturmasha_sesion_personal_v1',
     JSON.stringify({ email: 'piero@watercorespace.pe' }));
   // recargar
   ```

**Resultado (medido tras recargar).**
- Pestañas visibles: las 9 (incluidas `contabilidad` y `ajustes`).
- Selector de empresa presente (acceso global a todas las empresas de la red).
- Selector rápido de rol presente (admin/chofer/ayudante/promotor).
- **Sin haber escrito ninguna contraseña.** `cargarSesionPersonal()` confiaba en el
  `email` guardado y solo comprobaba que existiera en la lista del código.

**Impacto.** Cualquier visitante es SuperAdmin: ve y edita la contabilidad y los datos
de todas las empresas, cambia plantillas, modelos de pago, adjudica subastas.
Además: `btnCambiarModo` cambia a la cuenta hermana **sin re-pedir contraseña**; toda
la matemática de comisiones/nómina se calcula en el cliente y es manipulable con
devtools; el aislamiento entre empresas (`empresaActivaId`) es solo de interfaz.

**Contramedida aplicada (parcial).**
- Caducidad de la sesión guardada: 12 h con marca de tiempo (`guardarSesionPersonal`/
  `cargarSesionPersonal`). Acota una sesión olvidada en equipo compartido o restaurada
  de un backup viejo. **No** frena una forja deliberada.
- **Pendiente del dueño:** esto solo se cierra de verdad con Supabase Auth (sesión real
  firmada por el servidor, `auth.uid()`), y rotando todas las contraseñas + la anon
  key, que quedaron publicadas. Mientras tanto, como mínimo: sacar la cuenta
  `superAdmin` del bundle de producción y no usar la misma contraseña (`admin2026`,
  `chofer2026`, …) para todo el mundo.

---

## Contramedidas aplicadas en esta fase (resumen)

| Vector | Medida | Archivo |
|---|---|---|
| XSS almacenado | saneo en el borde + escape en sinks + CSP estricta + SRI | `app.js`, `index.html`, `vercel.json` |
| Inyección/flooding en BD | `CHECK` (longitud/rango/enum), `no_html()`, triggers de throttle | `supabase_schema.sql` |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'` | `vercel.json` |
| Sniffing MIME | `X-Content-Type-Options: nosniff` | `vercel.json` / `<meta>` |
| Fuga por Referer | `Referrer-Policy: strict-origin-when-cross-origin` | `vercel.json` / `<meta>` |
| Abuso de APIs del navegador | `Permissions-Policy` restrictiva | `vercel.json` |
| Sesión olvidada/robada de backup | caducidad de 12 h | `app.js` |
| Deriva de dependencias | versión exacta + SRI en Leaflet y supabase-js | `index.html` |

## Lo que NO se puede cerrar sin decisión del dueño

1. **Autorización en el servidor** (Ataque 1): Supabase Auth o Edge Function gateway.
2. **Credenciales en el bundle** (Ataque 3): rotarlas y dejar de embeberlas; adoptar Auth.
3. Confirmar **rama de producción** y desplegar `vercel.json` + `app.js` + el nuevo
   `supabase_schema.sql`.

## Efecto colateral del pentest — filas de prueba en producción

Durante el Ataque 2, la **sincronización automática de la app** (`guardarPedidos` ->
`reconciliarRemoto`), que estaba activa porque la instancia local apunta al Supabase
real, subió **22 filas de prueba** a `pedidos` (`PED-EVIL*`, `PED-XT0..11`,
`PED-XZ0..8`). Son **inertes**: `sanText()` les quitó todo `<>"'` antes de subirlas
(lo cual, de paso, vuelve a confirmar que la mitigación funciona). Pero son basura.

No pude borrarlas: este entorno bloquea escrituras/borrados contra bases remotas.
**Acción del dueño:** ejecutar `LIMPIAR-filas-pentest.sql` (deja `pedidos` en 19).
Para futuras pruebas conviene apuntar la instancia local a un Supabase de staging o
correr en modo solo-localStorage.

## Debilidad conocida de la CSP actual (RESUELTA en esta fase)

`script-src` ya NO permite CDNs de terceros: Leaflet 1.9.4 y supabase-js 2.115.0 se
**auto-hospedan** en `/vendor/`. La CSP quedó `script-src 'self'` a secas. Solo
quedan externos los tipos de bajo riesgo: la hoja de estilos de Google Fonts
(`style-src`), los archivos de fuente (`font-src`), los tiles del mapa (`img-src`) y
la geocodificación de Nominatim (`connect-src`).

`script-src` permite `https://cdn.jsdelivr.net` y `https://unpkg.com` enteros (hacen
falta para supabase-js y Leaflet). Son CDNs de npm: si un atacante lograra inyectar una
etiqueta `<script src>` (hoy no puede, no hay sink que lo permita y `sanText` quita
`<`), podría cargar cualquier paquete. Mitigación futura: auto-hospedar los 2 archivos
(`/vendor/…`) y dejar `script-src 'self'` a secas.
