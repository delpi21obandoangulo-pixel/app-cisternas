# Bitácora — WaterCore Space (web → app de celular)

Registro paso a paso de todos los avances. **Un archivo por fase**; dentro, una
entrada por sub-paso, con: qué se hizo, archivos tocados, commit, verificación y
lo que queda pendiente.

> Fuente de verdad: esta carpeta (`bitacora/` del repo).
> Espejo en Obsidian: `Brain/kunturmasha/agua/Bitácora — Web a App.md`
> (se actualiza junto con esta carpeta).

## Fases

| Fase | Archivo | Estado |
|---|---|---|
| Informe base | [`../INFORME-APP-MOVIL.md`](../INFORME-APP-MOVIL.md) / `.docx` | ✅ entregado |
| **Fase 0 — Endurecer la PWA** | [`fase-0-pwa.md`](fase-0-pwa.md) | 🟡 0.1–0.9 + 0.6b (minificación) hechos y desplegados; 0.2 (capturas reales) diferido |
| **Fase 1 — Bloqueantes de tienda** | [`fase-1-bloqueantes.md`](fase-1-bloqueantes.md) | 🟡 1.2/1.3/1.4 adelantados (parte autónoma); 1.1 pendiente (decisión del dueño) |
| Fase 2 — Capacitor (Android) | `fase-2-capacitor.md` | ⬜ sin empezar |
| Fase 3 — Push notifications | `fase-3-push.md` | ⬜ sin empezar |
| Fase 4 — iOS | `fase-4-ios.md` | ⬜ diferido |

## Cómo se registra cada paso

```
### 0.X — Título del paso            [YYYY-MM-DD]  ✅ hecho | 🟡 parcial | ⬜ pendiente
- Qué se hizo: ...
- Archivos: index.html, app.js, ...
- Commit: `<hash>` <mensaje corto>
- Desplegado: sí/no (URL)
- Verificación: cómo se comprobó y resultado
- Pendiente / notas: ...
```

## Convenciones del proyecto (recordatorio)

- Repo: `github.com/delpi21obandoangulo-pixel/app-cisternas`, rama `master`.
- Deploy: Vercel → `https://kunturmasha.vercel.app` (independiente de git;
  `npx vercel --prod`).
- Supabase: `mwvyhjvafwimcdxfyutf` (esquema `public`). Cambios de BD = SQL en
  `supabase_schema.sql`, los aplica el dueño.
- Aislamiento: no se tocan recursos de otros proyectos (Aura/Safari/etc.).
