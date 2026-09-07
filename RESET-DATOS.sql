-- ============================================================================
-- RESET "RENACIDO" — vaciar todos los datos operativos (2026-09-07)
-- ============================================================================
-- Deja la base como recién nacida: cero pedidos, cero gastos, cero solicitudes /
-- ofertas del Hub, y cero políticas de pago por empresa. Todas las empresas
-- asociadas quedan en 0.
--
-- Ejecuta esto en el SQL Editor de Supabase (proyecto mwvyhjvafwimcdxfyutf).
-- El esquema, las tablas, las políticas RLS y los triggers NO se tocan — solo
-- las filas. Es reversible solo si tienes una copia previa.
--
-- El código de la app (app.js) ya hace su propia limpieza del localStorage en
-- cada navegador la primera vez que carga la versión nueva (marca "wcs_reset").
-- ============================================================================

begin;

-- Cuánto había antes (para dejar constancia en el output)
select
  (select count(*) from public.pedidos)                as pedidos,
  (select count(*) from public.gastos)                 as gastos,
  (select count(*) from public.solicitudes_centrales)  as solicitudes,
  (select count(*) from public.ofertas_subasta)        as ofertas,
  (select count(*) from public.config_empresas)        as config_empresas;

delete from public.ofertas_subasta;        -- primero: FK -> solicitudes_centrales
delete from public.solicitudes_centrales;
delete from public.pedidos;
delete from public.gastos;
delete from public.config_empresas;        -- cada empresa vuelve a sus valores por defecto

-- Debe quedar todo en 0
select
  (select count(*) from public.pedidos)                as pedidos,
  (select count(*) from public.gastos)                 as gastos,
  (select count(*) from public.solicitudes_centrales)  as solicitudes,
  (select count(*) from public.ofertas_subasta)        as ofertas,
  (select count(*) from public.config_empresas)        as config_empresas;

commit;

-- (Opcional) si además quieres reiniciar los contadores de identidad de las
-- tablas que usen secuencias, hazlo aparte; estas tablas usan ids de texto
-- generados por la app (PED-xx, GAS-xxx, SOL-xxx, OFE-xxx), así que no hay
-- secuencias que reiniciar.
