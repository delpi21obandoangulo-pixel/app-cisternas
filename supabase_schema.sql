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
-- Chofer/Afiliador) inicia sesión con un correo y contraseña fijos que la propia app
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

-- Correo del afiliador (una de las 5 cuentas afiliador1..5@kunturmasha.pe) que registró
-- este pedido, si lo hizo un afiliador — la app lo llena sola al crear el pedido, no es
-- un campo del formulario. Sirve para calcular la comisión del 5% de cada afiliador en
-- "Mi Perfil / Billetera" sin depender de nada guardado solo en un navegador.
alter table public.pedidos add column if not exists afiliador_email text;

-- Teléfono/WhatsApp de contacto del cliente, capturado en el formulario de Despacho.
-- Visible en la Agenda del día y en el registro detallado de Contabilidad.
alter table public.pedidos add column if not exists telefono text;

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
