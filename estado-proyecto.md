# estado-proyecto.md — PROYECTO AGUA (WaterCore Space / Despacho Hídrico)

> Documento de infraestructura exigido por la Sección 1.6 de las directrices globales.
> Última actualización: 2026-09-06 (sesión autónoma de auditoría + endurecimiento).

## 1. Identidad del proyecto

| Campo | Valor |
|---|---|
| Nombre | WaterCore Space — Despacho Hídrico / Hub Central multiempresa |
| Carpeta | `kunturmasha/PROYECTO AGUA` (independiente) |
| Repo git | local; ramas: `master`, `demo`, `demo-sandbox` (activa), worktrees |
| Rama de trabajo actual | `demo-sandbox` |
| Rama de producción | **SIN CONFIRMAR** (`master` vs `demo`) — pendiente que lo diga el dueño |

## 2. Infraestructura

### Hosting — Vercel
- Proyecto: `temporary-nimble-carbon-y0woxbp` (`prj_Cf564myict4q2gtBlYtM6ej9BLri`)
- Org: `team_9VfL9Q6vzIPd4Kvy3aFPbZzI`
- Sitio estático (sin build). Entrypoint `index.html` + `app.js` + `vercel.json`.
- `.env.local` solo contiene `VERCEL_OIDC_TOKEN` (gitignored, vida corta).

### Base de datos — Supabase
- Proyecto: **`mwvyhjvafwimcdxfyutf`** (`https://mwvyhjvafwimcdxfyutf.supabase.co`)
- Esquema: `public` (este proyecto es el único inquilino de esa instancia, hasta donde
  se sabe; no comparte instancia con Aura/Safari).
- anon key (publishable): `sb_publishable_Cazqtu…` — **pública en el bundle**, quemada.
- service_role: no usada por el cliente (no hay backend).
- **Aislamiento:** las herramientas MCP de Supabase conectadas a esta sesión
  (`supabase-aura`, `supabase-kunturmasha`) apuntan a OTROS proyectos. Por la Sección 1,
  NO se usan para tocar la base de AGUA. Todo cambio de BD de AGUA se entrega como SQL
  en `supabase_schema.sql` y lo ejecuta el dueño en el dashboard.

## 3. Arquitectura de carpetas

```
PROYECTO AGUA/
├── index.html            # HTML + CSS + <meta> CSP. Carga app.js (defer).
├── app.js                # Toda la lógica (IIFE ES5, ~4.4k líneas). Extraído de
│                         #   index.html en 2026-09-06 para poder usar CSP sin
│                         #   'unsafe-inline' en script-src.
├── vercel.json           # Cabeceras de seguridad (CSP, HSTS, X-Frame-Options, …).
├── supabase_schema.sql   # Esquema + RLS + CHECK + triggers de endurecimiento.
├── INFORME-AUDITORIA.md  # Auditoría inicial (arquitectura, seguridad, calidad).
├── INFORME-AUDITORIA-2.md# (se crea tras el auto-pentest)
├── estado-proyecto.md    # este archivo
├── kunturmasha-web.zip        # CRUFT — iteración vieja, no referenciada. Revisar/borrar.
└── kunturmasha_app.html       # CRUFT — app anterior (798 KB), no referenciada. Revisar/borrar.
```

## 4. Esquema de base de datos (resumen)

| Tabla | Uso | Escritura |
|---|---|---|
| `pedidos` | servicios de despacho | personal (validado solo en cliente) |
| `gastos` | contabilidad operativa | personal |
| `solicitudes_centrales` | Hub Central: solicitudes a subasta | clientes sin cuenta |
| `ofertas_subasta` | ofertas de empresas sobre solicitudes | personal de empresa |
| `config_empresas` | política de pagos por empresa | administrador de empresa |
| `perfiles` | *obsoleta* (Supabase Auth retirado) | — |

RLS: habilitada en las 5; políticas hoy `using(true)/with check(true)` separadas por
verbo. CHECK de longitud/rango/enumerado + `no_html()` + triggers de throttle añadidos
2026-09-06 (como `NOT VALID`: aplican a filas nuevas).

## 5. Modelo de seguridad (estado real)

- **Auth:** 100 % en el navegador. `app.js/CREDENCIALES_PERSONAL` lleva correos y
  contraseñas en claro (admin2026, chofer2026, …, piero2026 superadmin) + 150 cuentas
  generadas. Cualquiera que abra el fuente las tiene.
- **Autorización servidor:** ninguna real (auth.uid() siempre null). Con la anon key se
  puede llamar la API REST directo y saltarse la interfaz.
- **Mitigaciones aplicadas 2026-09-06:** saneo de texto en el borde (`sanText`), escape
  en sinks de `innerHTML`, CSP estricta (script-src sin unsafe-inline, app.js externo),
  SRI + versión fija en los CDN, cabeceras de endurecimiento, CHECK/trigger en BD.
- **Sigue pendiente (dueño):** adoptar Supabase Auth **o** Edge Function gateway; rotar
  anon key y todas las contraseñas; confirmar rama de producción.

## 6. Excepciones a la política de aislamiento

Ninguna solicitada ni aplicada en esta sesión. No se ha tocado ningún recurso de otro
proyecto (Aura, Safari, Kunturmasha-web, etc.).

## 7. Progreso de commits (esta sesión)

- `18cb26a` security: XSS (saneo + escape + CSP), IIFE a app.js externo, SRI
- `4fe81ce` security: esquema SQL endurecido (CHECK/no_html/throttle), validación de
  formularios, `estado-proyecto.md`
- `e094f22` security: auto-hospedar vendor (Leaflet/supabase-js), CSP a `script-src
  'self'`, informe de auto-pentest, caducidad de sesión
- `e06838f` feat(ui): capa de movimiento "menú esponja" (gel) + microinteracciones
  (`ui-fx.css` / `ui-fx.js`)

## 8. Archivos nuevos de esta sesión

| Archivo | Qué es |
|---|---|
| `INFORME-AUDITORIA.md` | Auditoría inicial completa |
| `INFORME-AUDITORIA-2.md` | Auto-pentest (3 métodos) + contramedidas |
| `estado-proyecto.md` | Este documento (Sección 1.6) |
| `app.js` | Toda la lógica (extraída de `index.html`) |
| `ui-fx.css`, `ui-fx.js` | Capa de animación / menús esponja |
| `vercel.json` | Cabeceras de seguridad |
| `vendor/` | Leaflet 1.9.4 + supabase-js 2.115.0 auto-hospedados |
| `LIMPIAR-filas-pentest.sql` | Borra 22 filas de prueba que el auto-sync subió al Supabase real |
| `supabase_schema.sql` | Reescrito: endurecido (CHECK, `no_html()`, triggers, vista) |

## 9. PENDIENTE — acción del dueño (bloqueado para Claude)

1. Ejecutar `supabase_schema.sql` (nuevo) en el SQL Editor de `mwvyhjvafwimcdxfyutf`.
2. Ejecutar `LIMPIAR-filas-pentest.sql` (deja `pedidos` en 19).
3. Decidir: **Supabase Auth** (recomendado) o **Edge Function gateway**.
4. Rotar la anon key y TODAS las contraseñas de `CREDENCIALES_PERSONAL` (publicadas).
5. Confirmar rama de producción (`master` vs `demo`) y desplegar a Vercel
   (`index.html` + `app.js` + `ui-fx.*` + `vendor/` + `vercel.json`).
6. (Opcional) Borrar del repo `kunturmasha-web.zip` y `kunturmasha_app.html` (cruft).
