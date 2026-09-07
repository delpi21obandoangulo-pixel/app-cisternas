# Reset "RENACIDO" — 2026-09-07

Acción puntual pedida por el dueño: dejar la app **limpia como si hubiera renacido**.

Commit: `1d250c2` · desplegado en `https://kunturmasha.vercel.app`.

---

## Qué se pidió

1. Borrar **todas** las cuentas de administrador / chofer / ayudante / promotor
   (y las 150 del Directorio Central). "No quiero ese tipo de cuentas más."
2. Dejar **solo 5 cuentas** con permiso total de ver toda la web.
3. Quitar todos los demás correos registrados en cualquier parte.
4. Limpiar los resultados reales del **día 21 y 23 de Kunturmasha**.
5. **Todas las empresas asociadas en 0**, como recién nacida.

---

## Qué se hizo — CÓDIGO (`app.js`, `1d250c2`)

| Antes | Ahora |
|---|---|
| `CREDENCIALES_PERSONAL` = ~28 cuentas fijas + 150 generadas (Directorio Central) | **5 cuentas**: `acceso1@watercorespace.pe` … `acceso5@watercorespace.pe`, contraseña `watercore2026`. Cada una: `roles: ['admin','chofer','ayudante','promotor']` + `accesoGlobal: true` + `superAdmin: true` → ven las **9 pestañas**, el **selector de rol** (4) y el **selector de empresa** (6). |
| `PERSONAS` = 15 personas (piero, frank, shimo, ronald, …) | 5 entradas (`acceso1`…`acceso5`). |
| `AJUSTES_HISTORICOS` = 2 saldos arrastrados (chofer1@, promotor1@, fecha 2026-08-21) | `[]` — todas las billeteras empiezan en 0. |
| Directorio Central de 150: `DIRECTORIO_APELLIDOS`, `DIRECTORIO_PALABRAS_ROL`, `capitalizarPalabra`, `generarDirectorioCentral`, `CREDENCIALES_PERSONAL.concat(...)` | Todo eliminado. `generarDirectorioCentral()` → `return []` (dead). `passwordOchoDigitos` se **conserva** (lo usa el alta manual de personal en Ajustes). El panel de Ajustes ya no se monta (`esPiero = false`). `PIERO_SUPERADMIN_EMAIL` repunta a `acceso1@watercorespace.pe`. |
| `EMPRESAS`: AquaTrujillo/GotaDorada/CisternasElValle con `choferesDemo` de ejemplo | Las 6 empresas siguen existiendo pero `choferesDemo: []` en todas. `plantillaSemilla()` produce `{}` para cada empresa asociada → **todas en 0**. |
| `index.html` comentario de Ajustes sobre "150 cuentas / Piero" | Actualizado. |

**Reset de `localStorage` por navegador:** al cargar la versión nueva, si
`localStorage.wcs_reset !== 'renacido-2026-09-07'` se borran **todas** las claves
`kunturmasha_*` y `sedeCentral_*` de ese navegador (una sola vez) y se deja la
marca. Luego la app recrea esas claves vacías. Para forzar otra limpieza futura:
cambiar `RESET_MARCA` en `app.js`.

---

## Qué se hizo — DATOS (`RESET-DATOS.sql`, lo corre el dueño)

`DELETE` de todas las filas de `pedidos`, `gastos`, `solicitudes_centrales`,
`ofertas_subasta`, `config_empresas` en Supabase (`mwvyhjvafwimcdxfyutf`). Incluye
los resultados reales del día 21 y 23 de Kunturmasha. El esquema, las políticas
RLS y los triggers **no se tocan** — solo las filas. El script imprime los conteos
antes y después (todo debe quedar en 0).

> Hasta que el dueño corra este SQL, cada navegador que abra la app volverá a
> sincronizar los ~19 pedidos + 9 gastos que siguen en la base remota (así se ve
> en la prueba local). Después de correrlo, todo queda en 0 para todos.

---

## Verificación (Chrome, local)

- Login con cuenta vieja (`admin2@kunturmasha.pe`) → **falla** (error de credenciales).
- Login `acceso1@watercorespace.pe` / `watercore2026` → **9 pestañas**, selector de
  rol con `admin/chofer/ayudante/promotor`, selector de empresa con las 6, cabecera
  "Acceso 1".
- Agenda 0 tarjetas · Contabilidad todos los tiles en `0` / `S/. 0.00` · plantilla
  de personal vacía en todas las empresas.
- Ciclo de las 9 vistas + cambio de empresa + cambio de rol → **sin errores**.
- En prod: bundle con `acceso1..5@watercorespace`, marca `renacido-2026-09-07`, y
  **cero** referencias a `@kunturmasha.pe` / cuentas viejas.

---

## Pendiente (dueño)

1. **Correr `RESET-DATOS.sql`** en Supabase → deja la base en 0 (borra el día 21 y 23).
2. (Opcional) cambiar la contraseña compartida `watercore2026` por una por cuenta.
3. Avisar a quien use la app: las cuentas viejas ya no existen; entrar con
   `acceso1..5@watercorespace.pe`.
