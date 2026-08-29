-- ============================================================================
-- Despacho Hídrico — esquema de Supabase
-- ============================================================================
-- Cómo usar este archivo:
--   1. Entra a tu proyecto en https://supabase.com/dashboard
--   2. Ve a "SQL Editor" (menú izquierdo) → "New query"
--   3. Pega TODO este archivo y presiona "Run"
--   4. Debería terminar sin errores. Si necesitas volver a correrlo, es seguro:
--      usa "create table if not exists", "drop policy if exists" y
--      "create or replace function" antes de recrear cada pieza, así que se
--      puede ejecutar más de una vez sin romper nada.
--
-- El control de acceso de esta app YA NO usa Supabase Auth: el personal (Administrador/
-- Chofer/Promotor) inicia sesión con un correo y contraseña fijos que la propia app
-- valida en el navegador (ver index.html, CREDENCIALES_PERSONAL), y los clientes entran
-- directo sin ninguna cuenta. Como nunca hay una sesión real de Supabase Auth, auth.uid()
-- es siempre null aquí — las políticas de abajo son deliberadamente abiertas (using(true))
-- en vez de exigir auth.uid(): el control de "quién puede hacer qué" queda del lado de la
-- interfaz, no del servidor. Esto es un cambio de diseño consciente (simplicidad sobre
-- reforzar permisos en el servidor); la anon key ya es pública en el frontend de todas
-- formas, así que técnicamente cualquiera con esa key puede leer/escribir estas dos tablas
-- llamando a la API directo, sin pasar por la app.
-- ============================================================================

-- ---------- Tabla: pedidos ----------
create table if not exists public.pedidos (
  id                  text primary key,
  fecha               date not null,
  orden               int,
  cliente             text,
  codigo_cliente      text,
  ubicacion           text,
  hora_inicio         text,
  hora_fin            text,
  precio              numeric(10,2),
  chofer              text,
  ayudante            text,
  tipo_almacen        text,
  piso                text,
  dificultad          text,
  manguera            text,
  notas               text,
  estado              text,
  motivo_cancelacion  text,
  tiempos             jsonb,
  created_at          timestamptz not null default now()
);

comment on table public.pedidos is 'Pedidos de despacho de agua (uno por servicio agendado).';

create index if not exists pedidos_fecha_idx on public.pedidos (fecha);
create index if not exists pedidos_codigo_cliente_idx on public.pedidos (codigo_cliente);

-- Cambio de terminología "Afiliador" -> "Promotor" (ver index.html): si el proyecto ya
-- corrió una versión anterior de este archivo, la columna vieja "afiliador_email" existe
-- con datos reales — se renombra en vez de perder esos datos. En un proyecto nuevo (que
-- nunca corrió la versión vieja) la columna vieja no existe y este bloque no hace nada.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pedidos' and column_name = 'afiliador_email'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pedidos' and column_name = 'promotor_email'
  ) then
    alter table public.pedidos rename column afiliador_email to promotor_email;
  end if;
end $$;

-- Correo del promotor (una de las 5 cuentas promotor1..5@kunturmasha.pe) que registró
-- este pedido, si lo hizo un promotor — la app lo llena sola al crear el pedido, no es
-- un campo del formulario. Sirve para calcular la comisión del 5% de cada promotor en
-- "Mi Perfil / Billetera" sin depender de nada guardado solo en un navegador.
alter table public.pedidos add column if not exists promotor_email text;

-- Teléfono/WhatsApp de contacto del cliente, capturado en el formulario de Despacho.
-- Visible en la Agenda del día y en el registro detallado de Contabilidad.
alter table public.pedidos add column if not exists telefono text;

-- Empresa/pozo dueña de este pedido (marketplace multiempresa, rama "demo") — todo pedido
-- ya existente antes de este cambio se backfillea a 'kunturmasha' (Sede Central), así que
-- nada de lo ya registrado cambia de dueño. La app de producción (rama principal) no lee ni
-- escribe esta columna: puede existir en la misma base sin que production note diferencia.
alter table public.pedidos add column if not exists empresa_id text not null default 'kunturmasha';
update public.pedidos set empresa_id = 'kunturmasha' where empresa_id is null;
create index if not exists pedidos_empresa_idx on public.pedidos (empresa_id);

-- Volumen (m³) y método de pago — mismos parámetros técnicos que el formulario público del
-- Hub Central, ahora también en el registro interno de pedidos ("Despacho") de cada empresa.
alter table public.pedidos add column if not exists volumen_m3 numeric(6,2);
alter table public.pedidos add column if not exists metodo_pago text;

-- ---------- Tabla: gastos ----------
create table if not exists public.gastos (
  id           text primary key,
  fecha        date not null,
  categoria    text,
  descripcion  text,
  monto        numeric(10,2),
  created_at   timestamptz not null default now()
);

comment on table public.gastos is 'Gastos operativos registrados (combustible, mantenimiento, viáticos, etc.).';

create index if not exists gastos_fecha_idx on public.gastos (fecha);

-- Misma lógica que pedidos.empresa_id (ver arriba): Contabilidad queda independiente por
-- empresa/pozo asociado. Gastos ya existentes quedan en 'kunturmasha'.
alter table public.gastos add column if not exists empresa_id text not null default 'kunturmasha';
update public.gastos set empresa_id = 'kunturmasha' where empresa_id is null;

-- ============================================================================
-- ---------- public.perfiles: YA NO SE USA (Supabase Auth fue retirado) --------
-- ============================================================================
-- Si esta tabla existe de una versión anterior de la app, la dejamos tal cual (borrarla
-- no es necesario para que la app funcione) pero le quitamos las políticas RLS viejas que
-- dependían de auth.uid() — ya no hay sesiones de Supabase Auth que las cumplan. No se
-- crea contenido nuevo aquí a propósito: los roles del personal ahora viven como
-- constantes en index.html (CREDENCIALES_PERSONAL), no en esta tabla. Todo envuelto en un
-- chequeo de "¿existe la tabla?" porque en un proyecto nuevo (que nunca corrió la versión
-- vieja de este archivo) public.perfiles no existe, y "drop policy ... on" exige que la
-- tabla exista aunque la política no.
do $$
begin
  if to_regclass('public.perfiles') is not null then
    execute 'drop policy if exists "perfiles_select_publico" on public.perfiles';
    execute 'drop policy if exists "perfiles_select_autenticado" on public.perfiles';
    execute 'drop policy if exists "perfiles_insert_propio" on public.perfiles';
    execute 'drop policy if exists "perfiles_update_admin" on public.perfiles';
  end if;
end $$;

-- ---------- Row Level Security ----------
alter table public.pedidos enable row level security;
alter table public.gastos  enable row level security;

-- GRANT explícito de tabla a los roles públicos de Supabase (ver nota junto a las tablas del
-- Hub Central más abajo): la RLS abierta no sustituye al privilegio de tabla.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.pedidos to anon, authenticated;
grant select, insert, update, delete on public.gastos  to anon, authenticated;

-- pedidos: acceso abierto en las 4 operaciones — clientes sin cuenta pueden ver la
-- agenda y cotizar, y el personal (validado solo en la interfaz, ver nota de arriba)
-- puede crear/editar/borrar. drop de las políticas antiguas basadas en mi_rol()/auth.uid()
-- primero, porque ya no hay sesión que las satisfaga.
drop policy if exists "pedidos_select_publico" on public.pedidos;
drop policy if exists "pedidos_select_autenticado" on public.pedidos;
drop policy if exists "pedidos_insert_publico" on public.pedidos;
drop policy if exists "pedidos_insert_staff" on public.pedidos;
drop policy if exists "pedidos_update_publico" on public.pedidos;
drop policy if exists "pedidos_update_staff" on public.pedidos;
drop policy if exists "pedidos_delete_publico" on public.pedidos;
drop policy if exists "pedidos_delete_admin" on public.pedidos;
drop policy if exists "pedidos_acceso_abierto" on public.pedidos;
create policy "pedidos_acceso_abierto" on public.pedidos
  for all using (true) with check (true);

-- gastos: mismo criterio — la pestaña Contabilidad ya está oculta en la interfaz para
-- quien no sea Administrador, pero a nivel de base de datos queda abierta igual que
-- pedidos (ver nota de diseño al inicio del archivo).
drop policy if exists "gastos_select_publico" on public.gastos;
drop policy if exists "gastos_select_admin" on public.gastos;
drop policy if exists "gastos_insert_publico" on public.gastos;
drop policy if exists "gastos_insert_admin" on public.gastos;
drop policy if exists "gastos_update_publico" on public.gastos;
drop policy if exists "gastos_update_admin" on public.gastos;
drop policy if exists "gastos_delete_publico" on public.gastos;
drop policy if exists "gastos_delete_admin" on public.gastos;
drop policy if exists "gastos_acceso_abierto" on public.gastos;
create policy "gastos_acceso_abierto" on public.gastos
  for all using (true) with check (true);

-- ============================================================================
-- ---------- Marketplace multiempresa: Hub Central + Subasta (rama "demo") ----
-- ============================================================================
-- Tablas nuevas e independientes de pedidos/gastos — production (rama principal) no las
-- referencia en absoluto, así que aunque vivan en el mismo proyecto de Supabase, no hay
-- ningún cambio de comportamiento posible en production por su sola existencia.

-- Una solicitud pública que cualquier cliente publica sin cuenta (RLS abierta, igual que
-- pedidos/gastos). "hora_fin" es el cierre de la ventana de subasta (30 min desde que se
-- publica); el teléfono queda oculto en la pizarra de ofertas hasta que hay ganador —
-- ese ocultamiento es solo de interfaz (ver nota de diseño al inicio del archivo).
create table if not exists public.solicitudes_centrales (
  id                      text primary key,
  created_at              timestamptz not null default now(),
  cliente                 text,
  telefono                text,
  volumen_m3              numeric(6,2),
  ubicacion               text,
  tipo_descarga           text,
  hora_fin                timestamptz not null,
  estado                  text not null default 'Abierta'
                          check (estado in ('Abierta','Adjudicada','Cerrada sin ofertas')),
  empresa_ganadora_id     text,
  oferta_ganadora_precio  numeric(10,2),
  oferta_ganadora_tiempo  int,               -- minutos de entrega ofrecidos por el ganador
  comision_sede_central   numeric(10,2),
  pedido_generado_id      text               -- id en public.pedidos creado al adjudicar
);
comment on table public.solicitudes_centrales is 'Hub Central: solicitudes de agua publicadas por clientes, a subasta entre empresas asociadas.';
create index if not exists solicitudes_estado_idx on public.solicitudes_centrales (estado);

-- Mapa interactivo (Leaflet) del formulario de publicar solicitud: coordenadas exactas del
-- pin, más los dos parámetros técnicos nuevos del formulario (metros de manguera y piso —
-- este último solo aplica si tipo_descarga = 'Tanque Elevado', queda vacío en los demás casos).
alter table public.solicitudes_centrales add column if not exists lat numeric(9,6);
alter table public.solicitudes_centrales add column if not exists lng numeric(9,6);
alter table public.solicitudes_centrales add column if not exists manguera_metros text;
alter table public.solicitudes_centrales add column if not exists piso text;

-- Una oferta de una empresa sobre una solicitud — varias empresas pueden ofertar sobre la
-- misma solicitud; "upsert" por (solicitud_id, empresa_id) para que actualizar tu oferta
-- reemplace la anterior en vez de acumular filas.
create table if not exists public.ofertas_subasta (
  id                  text primary key,
  solicitud_id        text not null references public.solicitudes_centrales(id) on delete cascade,
  empresa_id          text not null,
  precio              numeric(10,2) not null,
  tiempo_entrega_min  int not null,
  created_at          timestamptz not null default now(),
  unique (solicitud_id, empresa_id)
);
comment on table public.ofertas_subasta is 'Ofertas de precio/tiempo de entrega de cada empresa sobre una solicitud del Hub Central.';

-- Nombre de la empresa en el momento de ofertar (denormalizado a propósito): así la pizarra
-- de subasta no depende de resolver empresa_id -> nombre en el navegador de quien mira.
-- Va DESPUÉS del "create table" de arriba (antes estaba antes, y en una base nueva la
-- corrida entera abortaba aquí con "relation ... does not exist", dejando el marketplace
-- sin políticas ni GRANT — el origen del "permission denied for table").
alter table public.ofertas_subasta add column if not exists empresa_nombre text;
update public.ofertas_subasta set empresa_nombre = empresa_id where empresa_nombre is null;

alter table public.solicitudes_centrales enable row level security;
alter table public.ofertas_subasta       enable row level security;

-- GRANT de tabla a los roles públicos de Supabase. La RLS abierta de abajo NO basta por sí
-- sola: sin este GRANT, anon recibe "permission denied for table" antes de que la política
-- llegue a evaluarse (mismo motivo por el que pedidos/gastos también necesitan su GRANT
-- implícito de Supabase). Explícito aquí para no depender de los privilegios por defecto.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.solicitudes_centrales to anon, authenticated;
grant select, insert, update, delete on public.ofertas_subasta       to anon, authenticated;

drop policy if exists "solicitudes_acceso_abierto" on public.solicitudes_centrales;
create policy "solicitudes_acceso_abierto" on public.solicitudes_centrales
  for all using (true) with check (true);

drop policy if exists "ofertas_acceso_abierto" on public.ofertas_subasta;
create policy "ofertas_acceso_abierto" on public.ofertas_subasta
  for all using (true) with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'solicitudes_centrales'
  ) then
    alter publication supabase_realtime add table public.solicitudes_centrales;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ofertas_subasta'
  ) then
    alter publication supabase_realtime add table public.ofertas_subasta;
  end if;
end $$;

-- ============================================================================
-- ---------- Política de pagos por empresa (Mi Perfil del Administrador) -------
-- ============================================================================
-- Cada empresa asociada define aquí cómo se le paga a chofer, ayudante y promotor (ver
-- index.html, configPagosDe()/guardarConfigPagos()/panelConfigPagosHtml()). Una fila por
-- empresa_id — "upsert" al guardar, así que nunca hay más de una fila por empresa. Si una
-- empresa nunca guardó nada, simplemente no tiene fila aquí y la app usa sus valores por
-- defecto (el comportamiento de siempre) desde el propio código, sin necesidad de leer nada.
create table if not exists public.config_empresas (
  empresa_id           text primary key,
  chofer_modalidad     text not null default 'legado'
                       check (chofer_modalidad in ('legado','fijo_dia','fijo_viaje','porcentaje_viaje')),
  chofer_monto         numeric(10,2) not null default 0,
  ayudante_modalidad   text not null default 'legado'
                       check (ayudante_modalidad in ('legado','fijo_dia','fijo_viaje','porcentaje_viaje')),
  ayudante_monto       numeric(10,2) not null default 0,
  promotor_habilitado  boolean not null default true,
  promotor_modalidad   text not null default 'porcentaje_viaje'
                       check (promotor_modalidad in ('fijo_dia','fijo_viaje','porcentaje_viaje')),
  promotor_monto       numeric(10,2) not null default 5,
  updated_at           timestamptz not null default now()
);
comment on table public.config_empresas is 'Política de pagos (chofer/ayudante/promotor) configurable por cada empresa asociada — una fila por empresa_id.';

alter table public.config_empresas enable row level security;
grant select, insert, update, delete on public.config_empresas to anon, authenticated;
drop policy if exists "config_empresas_acceso_abierto" on public.config_empresas;
create policy "config_empresas_acceso_abierto" on public.config_empresas
  for all using (true) with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'config_empresas'
  ) then
    alter publication supabase_realtime add table public.config_empresas;
  end if;
end $$;

-- ---------- Realtime ----------
-- Para que la app reciba cambios en vivo (otro dispositivo agenda/edita/borra
-- un pedido y se refleja solo, sin recargar), las tablas deben pertenecer a la
-- publicación "supabase_realtime". Si ya pertenecen, estas líneas no hacen nada.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pedidos'
  ) then
    alter publication supabase_realtime add table public.pedidos;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'gastos'
  ) then
    alter publication supabase_realtime add table public.gastos;
  end if;
end $$;

-- ============================================================================
-- Pasos manuales en el Dashboard de Supabase: NINGUNO.
-- Esta app ya no usa Supabase Auth (ni Google ni correo/contraseña de Supabase) — el
-- login del personal se valida en el propio index.html contra una lista fija de
-- correos/contraseñas (CREDENCIALES_PERSONAL). No hace falta activar ningún proveedor
-- ni configurar "Site URL" / "Redirect URLs" en Authentication.
-- ============================================================================
