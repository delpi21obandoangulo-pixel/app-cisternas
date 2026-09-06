-- ============================================================================
-- Despacho Hídrico / WaterCore Space — esquema de Supabase (ENDURECIDO)
-- Proyecto Supabase: mwvyhjvafwimcdxfyutf   ·   Esquema: public
-- ============================================================================
-- Cómo usar este archivo:
--   1. https://supabase.com/dashboard  ->  proyecto mwvyhjvafwimcdxfyutf
--   2. SQL Editor  ->  New query
--   3. Pega TODO y "Run". Es idempotente: se puede re-ejecutar sin romper nada
--      (create ... if not exists / drop policy if exists / add constraint guardado
--      contra su existencia).
--
-- ----------------------------------------------------------------------------
-- MODELO DE SEGURIDAD — leer antes de tocar nada
-- ----------------------------------------------------------------------------
-- Esta app NO usa Supabase Auth. El personal se valida en el navegador contra
-- una lista fija (app.js, CREDENCIALES_PERSONAL) y los clientes entran sin cuenta.
-- Nunca hay sesión de Supabase => auth.uid() es siempre null => las políticas no
-- pueden distinguir "quién" hace la llamada. La anon key va en el bundle público.
--
-- Consecuencia inevitable con este diseño: cualquiera con la anon key puede llamar
-- a la API REST directamente. NO se puede cerrar del todo sin uno de estos dos
-- cambios de arquitectura (ver bloque final "CAMINO A SEGURIDAD REAL"):
--     A) Adoptar Supabase Auth (recomendado).
--     B) Un Edge Function "gateway" que tenga la service_role key y valide;
--        las tablas quedarían solo-lectura (o sin acceso) para anon.
--
-- Lo que SÍ hace este archivo, como mitigación intermedia (defensa en profundidad
-- junto al saneo de app.js y la CSP de vercel.json):
--   * CHECK de longitud, rango y enumerados en TODA columna escribible  -> corta
--     payloads gigantes, datos corruptos y limita el hueco de un XSS almacenado.
--   * no_html(): rechaza  <  >  y caracteres de control en texto libre  -> el
--     servidor rebota los payloads de <script>/<img onerror> aunque el cliente
--     fallara en sanearlos.
--   * Throttle por trigger en las tablas públicas (Hub) -> limita el flooding.
--   * Políticas por operación (en vez de FOR ALL) -> base para ir cerrando cada
--     verbo cuando se migre a Auth/gateway.
--   * REVOKE de UPDATE sobre columnas de auditoría (created_at).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Utilidades de validación reutilizables
-- ---------------------------------------------------------------------------
-- NOTA: los CHECK se añaden como NOT VALID -> se aplican a TODO insert/update
-- nuevo, pero no revientan si hay filas viejas que los violan. Para verificar y
-- "sellar" los datos existentes cuando estés seguro:
--   alter table public.pedidos validate constraint pedidos_no_html;   -- etc.
-- (si alguno falla, limpia esas filas antes de validar).
-- Rechaza apertura de etiqueta HTML y controles. IMMUTABLE para poder usarse en
-- CHECK. No pretende "sanear" (eso es del cliente), solo cerrar la puerta a lo
-- que solo sirve para inyectar.
create or replace function public.no_html(t text)
returns boolean
language sql
immutable
as $$
  select t is null
      or (position('<' in t) = 0
      and position('>' in t) = 0
      and t !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]');
$$;

comment on function public.no_html(text) is
  'true si el texto no contiene < > ni caracteres de control. Para CHECK anti-XSS.';

-- ============================================================================
-- 1. Tabla: pedidos
-- ============================================================================
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

-- Migración histórica: afiliador_email -> promotor_email (no perder datos viejos).
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='pedidos' and column_name='afiliador_email')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='pedidos' and column_name='promotor_email') then
    alter table public.pedidos rename column afiliador_email to promotor_email;
  end if;
end $$;

alter table public.pedidos add column if not exists promotor_email text;
alter table public.pedidos add column if not exists telefono text;
alter table public.pedidos add column if not exists empresa_id text not null default 'kunturmasha';
update public.pedidos set empresa_id = 'kunturmasha' where empresa_id is null;
create index if not exists pedidos_empresa_idx on public.pedidos (empresa_id);
alter table public.pedidos add column if not exists volumen_m3 numeric(6,2);
alter table public.pedidos add column if not exists metodo_pago text;

-- ---- CHECK constraints (idempotentes vía bloque catch) -------------------
do $$
begin
  -- longitudes de texto libre + anti-HTML
  begin alter table public.pedidos add constraint pedidos_txt_len check (
      coalesce(length(id),0)             <= 80  and
      coalesce(length(cliente),0)        <= 120 and
      coalesce(length(codigo_cliente),0) <= 40  and
      coalesce(length(ubicacion),0)      <= 300 and
      coalesce(length(chofer),0)         <= 120 and
      coalesce(length(ayudante),0)       <= 120 and
      coalesce(length(tipo_almacen),0)   <= 60  and
      coalesce(length(piso),0)           <= 40  and
      coalesce(length(dificultad),0)     <= 20  and
      coalesce(length(manguera),0)       <= 40  and
      coalesce(length(notas),0)          <= 800 and
      coalesce(length(estado),0)         <= 40  and
      coalesce(length(motivo_cancelacion),0) <= 400 and
      coalesce(length(telefono),0)       <= 40  and
      coalesce(length(metodo_pago),0)    <= 40  and
      coalesce(length(promotor_email),0) <= 120
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.pedidos add constraint pedidos_no_html check (
      public.no_html(cliente) and public.no_html(codigo_cliente) and public.no_html(ubicacion)
      and public.no_html(chofer) and public.no_html(ayudante) and public.no_html(tipo_almacen)
      and public.no_html(piso) and public.no_html(dificultad) and public.no_html(manguera)
      and public.no_html(notas) and public.no_html(estado) and public.no_html(motivo_cancelacion)
      and public.no_html(telefono) and public.no_html(metodo_pago) and public.no_html(id)
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.pedidos add constraint pedidos_rangos check (
      (precio     is null or (precio     >= 0 and precio     <= 1000000)) and
      (volumen_m3 is null or (volumen_m3 >= 0 and volumen_m3 <= 100000)) and
      (orden      is null or (orden      >= 0 and orden      <= 100000)) and
      (fecha >= date '2020-01-01' and fecha < date '2100-01-01')
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.pedidos add constraint pedidos_estado_enum check (
      estado is null or estado in (
        'Programado','Llenado','En Ruta','Descarga','Regresando a Base','Completado',
        'Cancelado','Retiro Voluntario','No Completado'
      )
  ) not valid; exception when duplicate_object then null; end;
end $$;

-- ============================================================================
-- 2. Tabla: gastos
-- ============================================================================
create table if not exists public.gastos (
  id           text primary key,
  fecha        date not null,
  categoria    text,
  descripcion  text,
  monto        numeric(10,2),
  created_at   timestamptz not null default now()
);
comment on table public.gastos is 'Gastos operativos (combustible, mantenimiento, viáticos, etc.).';
create index if not exists gastos_fecha_idx on public.gastos (fecha);
alter table public.gastos add column if not exists empresa_id text not null default 'kunturmasha';
update public.gastos set empresa_id = 'kunturmasha' where empresa_id is null;

do $$
begin
  begin alter table public.gastos add constraint gastos_txt check (
      coalesce(length(id),0) <= 80 and
      coalesce(length(categoria),0) <= 120 and
      coalesce(length(descripcion),0) <= 400 and
      coalesce(length(empresa_id),0) <= 80 and
      public.no_html(categoria) and public.no_html(descripcion) and public.no_html(id)
  ) not valid; exception when duplicate_object then null; end;
  begin alter table public.gastos add constraint gastos_rangos check (
      (monto is null or (monto >= -1000000 and monto <= 1000000)) and
      (fecha >= date '2020-01-01' and fecha < date '2100-01-01')
  ) not valid; exception when duplicate_object then null; end;
end $$;

-- ============================================================================
-- 3. public.perfiles — YA NO SE USA (Supabase Auth retirado). Solo limpiamos
--    políticas viejas si la tabla existe de una versión anterior.
-- ============================================================================
do $$
begin
  if to_regclass('public.perfiles') is not null then
    execute 'drop policy if exists "perfiles_select_publico" on public.perfiles';
    execute 'drop policy if exists "perfiles_select_autenticado" on public.perfiles';
    execute 'drop policy if exists "perfiles_insert_propio" on public.perfiles';
    execute 'drop policy if exists "perfiles_update_admin" on public.perfiles';
  end if;
end $$;

-- ============================================================================
-- 4. Marketplace: Hub Central + Subasta
-- ============================================================================
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
  oferta_ganadora_tiempo  int,
  comision_sede_central   numeric(10,2),
  pedido_generado_id      text
);
comment on table public.solicitudes_centrales is 'Hub Central: solicitudes de agua a subasta entre empresas asociadas.';
create index if not exists solicitudes_estado_idx on public.solicitudes_centrales (estado);
create index if not exists solicitudes_created_idx on public.solicitudes_centrales (created_at);

alter table public.solicitudes_centrales add column if not exists lat numeric(9,6);
alter table public.solicitudes_centrales add column if not exists lng numeric(9,6);
-- OJO: en la base real esta columna quedó como integer (ver app.js solicitudARemoto,
-- que manda parseInt()). Si en tu proyecto es text, esta línea no la cambia; si vas a
-- normalizar, hazlo aparte.
alter table public.solicitudes_centrales add column if not exists manguera_metros integer;
alter table public.solicitudes_centrales add column if not exists piso text;

create table if not exists public.ofertas_subasta (
  id                  text primary key,
  solicitud_id        text not null references public.solicitudes_centrales(id) on delete cascade,
  empresa_id          text not null,
  precio              numeric(10,2) not null,
  tiempo_entrega_min  int not null,
  created_at          timestamptz not null default now(),
  unique (solicitud_id, empresa_id)
);
comment on table public.ofertas_subasta is 'Ofertas de precio/tiempo de cada empresa sobre una solicitud del Hub.';
alter table public.ofertas_subasta add column if not exists empresa_nombre text;
update public.ofertas_subasta set empresa_nombre = empresa_id where empresa_nombre is null;

do $$
begin
  begin alter table public.solicitudes_centrales add constraint sol_txt check (
      coalesce(length(id),0) <= 80 and
      coalesce(length(cliente),0) <= 120 and
      coalesce(length(telefono),0) <= 40 and
      coalesce(length(ubicacion),0) <= 400 and
      coalesce(length(tipo_descarga),0) <= 60 and
      coalesce(length(piso),0) <= 40 and
      coalesce(length(empresa_ganadora_id),0) <= 80 and
      coalesce(length(pedido_generado_id),0) <= 80 and
      public.no_html(cliente) and public.no_html(telefono) and public.no_html(ubicacion)
      and public.no_html(tipo_descarga) and public.no_html(piso) and public.no_html(id)
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.solicitudes_centrales add constraint sol_rangos check (
      (volumen_m3 is null or (volumen_m3 >= 0.1 and volumen_m3 <= 100)) and
      (oferta_ganadora_precio is null or (oferta_ganadora_precio >= 0 and oferta_ganadora_precio <= 100000)) and
      (oferta_ganadora_tiempo is null or (oferta_ganadora_tiempo >= 0 and oferta_ganadora_tiempo <= 10080)) and
      (manguera_metros is null or (manguera_metros >= 0 and manguera_metros <= 1000)) and
      (telefono is null or telefono ~ '^[0-9+()\-\s]{6,20}$')
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.solicitudes_centrales add constraint sol_tipo_descarga_enum check (
      tipo_descarga is null or tipo_descarga in ('Cisterna a nivel','Tanque Elevado','Directo','Otro')
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.ofertas_subasta add constraint ofe_txt check (
      coalesce(length(id),0) <= 80 and
      coalesce(length(solicitud_id),0) <= 80 and
      coalesce(length(empresa_id),0) <= 80 and
      coalesce(length(empresa_nombre),0) <= 120 and
      public.no_html(empresa_id) and public.no_html(empresa_nombre) and public.no_html(id)
  ) not valid; exception when duplicate_object then null; end;

  begin alter table public.ofertas_subasta add constraint ofe_rangos check (
      precio >= 1 and precio <= 100000 and
      tiempo_entrega_min >= 1 and tiempo_entrega_min <= 1440
  ) not valid; exception when duplicate_object then null; end;
end $$;

-- ---- Integridad de la subasta + throttle (triggers) ----------------------
-- hora_fin razonable al crear (ventana <= 2 h en el futuro, no en el pasado).
create or replace function public.solicitud_valida()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.hora_fin < now() - interval '1 minute'
       or new.hora_fin > now() + interval '2 hours' then
      raise exception 'hora_fin fuera de rango (ventana de subasta 1-120 min)';
    end if;
    -- Throttle global: máx 60 solicitudes creadas en los últimos 60 s.
    if (select count(*) from public.solicitudes_centrales
        where created_at > now() - interval '60 seconds') >= 60 then
      raise exception 'demasiadas solicitudes en poco tiempo, reintenta en un minuto';
    end if;
    -- Tope de solicitudes abiertas simultáneas.
    if (select count(*) from public.solicitudes_centrales where estado = 'Abierta') >= 500 then
      raise exception 'hay demasiadas solicitudes abiertas ahora mismo';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_solicitud_valida on public.solicitudes_centrales;
create trigger trg_solicitud_valida
  before insert on public.solicitudes_centrales
  for each row execute function public.solicitud_valida();

create or replace function public.oferta_valida()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.ofertas_subasta
        where created_at > now() - interval '60 seconds') >= 120 then
      raise exception 'demasiadas ofertas en poco tiempo, reintenta en un minuto';
    end if;
  end if;
  -- No ofertar sobre una solicitud que ya no está abierta.
  if not exists (select 1 from public.solicitudes_centrales
                 where id = new.solicitud_id and estado = 'Abierta') then
    raise exception 'la solicitud % no está abierta', new.solicitud_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_oferta_valida on public.ofertas_subasta;
create trigger trg_oferta_valida
  before insert or update on public.ofertas_subasta
  for each row execute function public.oferta_valida();

-- ============================================================================
-- 5. Política de pagos por empresa
-- ============================================================================
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
comment on table public.config_empresas is 'Política de pagos por empresa asociada — una fila por empresa_id.';

do $$
begin
  begin alter table public.config_empresas add constraint cfg_rangos check (
      coalesce(length(empresa_id),0) <= 80 and public.no_html(empresa_id) and
      chofer_monto   >= 0 and chofer_monto   <= 100000 and
      ayudante_monto >= 0 and ayudante_monto <= 100000 and
      promotor_monto >= 0 and promotor_monto <= 100000
  ) not valid; exception when duplicate_object then null; end;
end $$;

-- ============================================================================
-- 6. Row Level Security + GRANT + políticas POR OPERACIÓN
-- ============================================================================
alter table public.pedidos               enable row level security;
alter table public.gastos                enable row level security;
alter table public.solicitudes_centrales enable row level security;
alter table public.ofertas_subasta       enable row level security;
alter table public.config_empresas       enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.pedidos               to anon, authenticated;
grant select, insert, update, delete on public.gastos                to anon, authenticated;
grant select, insert, update, delete on public.solicitudes_centrales to anon, authenticated;
grant select, insert, update, delete on public.ofertas_subasta       to anon, authenticated;
grant select, insert, update, delete on public.config_empresas       to anon, authenticated;

-- created_at es de auditoría: que anon no lo pueda pisar en un UPDATE.
revoke update (created_at) on public.pedidos               from anon, authenticated;
revoke update (created_at) on public.gastos                from anon, authenticated;
revoke update (created_at) on public.solicitudes_centrales from anon, authenticated;
revoke update (created_at) on public.ofertas_subasta       from anon, authenticated;

-- Helper para (re)crear las 4 políticas de una tabla con las mismas reglas.
-- Hoy todas son using(true)/with check(true) — el valor está en tenerlas separadas
-- por verbo, listas para cerrarse una a una al migrar a Auth/gateway.
do $$
declare t text;
begin
  foreach t in array array['pedidos','gastos','solicitudes_centrales','ofertas_subasta','config_empresas'] loop
    execute format('drop policy if exists %I on public.%I', t||'_sel', t);
    execute format('drop policy if exists %I on public.%I', t||'_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_upd', t);
    execute format('drop policy if exists %I on public.%I', t||'_del', t);
    -- limpia también los nombres antiguos "..._acceso_abierto"
    execute format('drop policy if exists %I on public.%I', t||'_acceso_abierto', t);
    execute format('create policy %I on public.%I for select using (true)', t||'_sel', t);
    execute format('create policy %I on public.%I for insert with check (true)', t||'_ins', t);
    execute format('create policy %I on public.%I for update using (true) with check (true)', t||'_upd', t);
    execute format('create policy %I on public.%I for delete using (true)', t||'_del', t);
  end loop;
end $$;

-- ============================================================================
-- 7. Realtime
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['pedidos','gastos','solicitudes_centrales','ofertas_subasta','config_empresas'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================================
-- 8. (OPCIONAL) Vista pública sin teléfono para solicitudes aún no adjudicadas
-- ============================================================================
-- Hoy el teléfono del cliente se oculta SOLO en la interfaz: con la anon key
-- cualquiera hace  select telefono from solicitudes_centrales  y se lleva todos.
-- Esta vista lo enmascara mientras la solicitud no esté adjudicada. Para usarla
-- de verdad hay que, además: revoke select ... on solicitudes_centrales from anon,
-- grant select on solicitudes_publicas, y en app.js leer de 'solicitudes_publicas'
-- (y exponer el teléfono del ganador por otra vía). Se deja creada pero SIN
-- revocar el select base, para no romper la app tal como está hoy.
create or replace view public.solicitudes_publicas
with (security_invoker = true) as
  select id, created_at, cliente, volumen_m3, ubicacion, tipo_descarga, hora_fin,
         estado, empresa_ganadora_id, oferta_ganadora_precio, oferta_ganadora_tiempo,
         comision_sede_central, pedido_generado_id, lat, lng, manguera_metros, piso,
         case when estado = 'Adjudicada' then telefono else null end as telefono
  from public.solicitudes_centrales;
grant select on public.solicitudes_publicas to anon, authenticated;

-- ============================================================================
-- CAMINO A SEGURIDAD REAL (pendiente — decisión + acción del dueño del proyecto)
-- ============================================================================
--  A) Supabase Auth
--     - Activar proveedor Email en Authentication.
--     - Crear cuentas para el personal; guardar rol en app_metadata o en una
--       tabla public.perfiles(user_id, rol, empresa_id) con su propia RLS.
--     - Cambiar en app.js el login para usar supabase.auth.signInWithPassword.
--     - Reescribir políticas: SELECT público solo donde haga falta (agenda,
--       subasta), INSERT/UPDATE/DELETE exigiendo auth.uid() y rol/empresa.
--     - Rotar la anon key y TODAS las contraseñas de CREDENCIALES_PERSONAL
--       (están publicadas en el bundle).
--
--  B) Edge Function gateway
--     - Function con la service_role key que reciba las mutaciones, valide y
--       escriba. anon pierde insert/update/delete (solo select, y solo en las
--       tablas/columnas necesarias).
--     - app.js llama a la function en vez de a supabase.from(...).insert(...).
--
--  Mientras no se haga ni A ni B: este archivo es solo mitigación. Asumir que
--  los datos de estas tablas son legibles/escribibles por cualquiera con la URL.
-- ============================================================================
