(function(){
  'use strict';

  /* ==========================================================================
     Cliente de Supabase — se crea una sola vez, apenas arranca el script. Solo lo usa
     la sincronización de pedidos/gastos entre dispositivos (ver iniciarSupabase() más
     abajo); el login del personal (correo/contraseña) ya NO depende de esto — se valida
     contra CREDENCIALES_PERSONAL, más abajo, sin necesidad de conexión. Si no hay
     credenciales o el CDN no cargó (sin internet, bloqueado, etc.), queda en null: la
     app sigue funcionando igual (clientes, login de personal, agenda) pero guardando
     solo en este navegador, sin compartir cambios con otros dispositivos.
     ========================================================================== */
  var SUPABASE_URL = 'https://mwvyhjvafwimcdxfyutf.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_CazqtuMQ58i4wnT4ahM9iA_RPR0Mplu';
  function crearClienteSupabase(){
    if(!SUPABASE_URL || !SUPABASE_ANON_KEY) return null; // sin credenciales: modo local
    if(typeof window.supabase === 'undefined' || !window.supabase.createClient) return null; // CDN no cargó
    try{ return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
    catch(e){ return null; }
  }
  var supa = crearClienteSupabase(); // cliente de Supabase, o null si no hay conexión

  var STORAGE_KEY = 'sedeCentral_pedidos_v1';

  function isoHoy(){
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function isoDe(date){
    return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
  }
  function sumarDias(iso, n){
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoDe(d);
  }
  function formatearFechaLarga(iso){
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('es-PE', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  }

  var HOY = isoHoy();
  // Cuánto corresponde por UN viaje según la modalidad configurada (ver configPagosDe()):
  // "porcentaje_viaje" = % del precio del viaje; "fijo_viaje" = monto fijo por viaje;
  // "fijo_dia" = 0 aquí (se paga una sola vez por día, no por viaje — ver construirAsientos());
  // "legado" = el escalonado de siempre, para empresas que no configuraron nada todavía.
  function montoPorViajeSegunModalidad(modalidad, monto, precio, premiumLegado, estandarLegado){
    if(modalidad === 'porcentaje_viaje') return precio * ((Number(monto) || 0) / 100);
    if(modalidad === 'fijo_viaje') return Number(monto) || 0;
    if(modalidad === 'fijo_dia') return 0;
    return precio > 150 ? premiumLegado : estandarLegado; // 'legado'
  }
  // Sueldo por viaje completado — antes escalonado igual para todas las empresas, ahora
  // depende de la política de pagos de "empresaId" (Mi Perfil del Administrador). Si esa
  // empresa nunca configuró nada, se comporta exactamente como antes (ver configPagosDe()).
  function manoDeObra(precio, empresaId){
    precio = Number(precio) || 0;
    var cfg = configPagosDe(empresaId || empresaActivaId);
    return {
      chofer: montoPorViajeSegunModalidad(cfg.choferModalidad, cfg.choferMonto, precio, 20, 10),
      ayudante: montoPorViajeSegunModalidad(cfg.ayudanteModalidad, cfg.ayudanteMonto, precio, 10, 5)
    };
  }

  /* ==========================================================================
     Control de acceso por roles. Ya NO depende de Supabase Auth: el personal
     (Administrador/Chofer/Promotor) inicia sesión con correo y contraseña
     validados aquí mismo, contra la lista fija CREDENCIALES_PERSONAL — no hay
     registro, no hay recuperación de contraseña, no hay sesión de servidor.
     Los clientes no tienen cuenta: entran directo con rolActivo = 'cliente'.
     Las claves cortas de abajo (admin/cliente/chofer/promotor) son el
     vocabulario interno de la UI; MAPA_ROL_DB_A_INTERNO traduce el rol "bonito"
     (Administrador, etc.) a estas claves.
     ========================================================================== */
  var PROMOTOR_NOMBRE_KEY = 'kunturmasha_promotor_nombre_v1';
  var AFILIACIONES_KEY = 'kunturmasha_afiliaciones_v1';
  var SESION_PERSONAL_KEY = 'kunturmasha_sesion_personal_v1';
  var PERFIL_NOMBRES_KEY = 'kunturmasha_perfil_nombres_v1'; // { email: nombre editado desde "Mi Perfil" }, ver nombreMostrado()

  // Cuentas fijas del personal, de WaterCore Space (la sede/hub que administra la red) y de
  // cada una de las 5 empresas asociadas. La contraseña vive en texto plano aquí porque el
  // login se valida enteramente en el navegador (sin backend de autenticación) — es un
  // candado de interfaz para un equipo pequeño y conocido, no una defensa contra quien lea
  // el código fuente de la página. "nombre" es también el valor exacto que debe llevar el
  // campo "Chofer" del formulario de Despacho para que la comisión de Mi Perfil lo
  // reconozca (ver <select id="chofer"> y calcularComisionesChofer()) — por eso NUNCA
  // cambia en tiempo real, ni siquiera cuando la persona edita su nombre visible desde
  // "Mi Perfil" (eso solo cambia nombreMostrado(), no este campo).
  // "parejaEmail": cuenta hermana de la misma persona con otro rol (hoy solo Piero:
  // admin1 <-> chofer1) — habilita el botón "Cambiar a modo X" sin pedir contraseña de nuevo.
  // "personaId": a qué persona real pertenece esta cuenta (ver PERSONAS más abajo) — Piero,
  // Frank y Shimo tienen dos cuentas cada uno (Admin y Chofer) pero son UNA sola persona para
  // efectos de "Conseguido por / Promotor" y su comisión de promotor.
  // "empresaId": a qué empresa (ver EMPRESAS más abajo) pertenece esta cuenta — es la base del
  // aislamiento entre empresas asociadas (ver actualizarSelectorEmpresa()): una cuenta con
  // empresaId fijo solo puede operar esa empresa, nunca cambiar al espacio de otra.
  // "accesoGlobal": solo el equipo de WaterCore Space lo tiene — puede cambiar libremente entre
  // TODAS las empresas de la red (soporte/administración de la plataforma), igual que antes
  // podía cualquier Administrador cuando Kunturmasha era la Sede Central.
  // "roles": multi-rol dinámico (ver rolesDeCredencial()/cambiarRolActivo()) — con qué roles
  // internos puede operar esta cuenta SIN cerrar sesión y volver a loguearse, elegido desde
  // el selector rápido de rol de la cabecera. Si falta, la cuenta tiene un único rol fijo
  // (cred.rol), como siempre.
  // "superAdmin": Piero, cuenta maestra — accesoGlobal + los 4 roles de personal a la vez
  // (Administrador/Chofer/Ayudante/Promotor), pensada para pruebas y soporte de toda la red.
  var CREDENCIALES_PERSONAL = [
    { email: 'piero@watercorespace.pe', password: 'piero2026', rol: 'Administrador', roles: ['admin', 'chofer', 'ayudante', 'promotor'], nombre: 'Piero (SuperAdmin)', personaId: 'piero', empresaId: 'watercore-space', accesoGlobal: true, superAdmin: true },
    { email: 'admin@watercorespace.pe', password: 'watercore2026', rol: 'Administrador', nombre: 'Equipo WaterCore Space (Admin)', personaId: 'watercore-admin', empresaId: 'watercore-space', accesoGlobal: true },
    { email: 'admin1@kunturmasha.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Piero (Admin)', parejaEmail: 'chofer1@kunturmasha.pe', personaId: 'piero', empresaId: 'kunturmasha' },
    { email: 'admin2@kunturmasha.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Frank (Admin)', personaId: 'frank', empresaId: 'kunturmasha' },
    { email: 'admin3@kunturmasha.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Shimo (Admin)', personaId: 'shimo', empresaId: 'kunturmasha' },
    { email: 'chofer1@kunturmasha.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Piero (Chofer)', parejaEmail: 'admin1@kunturmasha.pe', personaId: 'piero', empresaId: 'kunturmasha' },
    { email: 'chofer2@kunturmasha.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Frank (Chofer)', personaId: 'frank', empresaId: 'kunturmasha' },
    { email: 'chofer3@kunturmasha.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Shimo (Chofer)', personaId: 'shimo', empresaId: 'kunturmasha' },
    { email: 'promotor1@kunturmasha.pe', password: 'promotor2026', rol: 'Promotor', nombre: 'Ronald (Promotor)', personaId: 'ronald', empresaId: 'kunturmasha' },
    { email: 'promotor2@kunturmasha.pe', password: 'promotor2026', rol: 'Promotor', nombre: 'Jherson (Promotor)', personaId: 'jherson', empresaId: 'kunturmasha' },
    { email: 'promotor3@kunturmasha.pe', password: 'promotor2026', rol: 'Promotor', nombre: 'Promotor 3', personaId: 'promotor3', empresaId: 'kunturmasha' },
    { email: 'promotor4@kunturmasha.pe', password: 'promotor2026', rol: 'Promotor', nombre: 'Promotor 4', personaId: 'promotor4', empresaId: 'kunturmasha' },
    { email: 'promotor5@kunturmasha.pe', password: 'promotor2026', rol: 'Promotor', nombre: 'Promotor 5', personaId: 'promotor5', empresaId: 'kunturmasha' },
    { email: 'admin@aquatrujillo.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Admin AquaTrujillo', personaId: 'admin-aquatrujillo', empresaId: 'aqua-trujillo' },
    { email: 'chofer@aquatrujillo.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Chofer AquaTrujillo 1', personaId: 'chofer-aquatrujillo-1', empresaId: 'aqua-trujillo' },
    { email: 'admin@gotadorada.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Admin Gota Dorada', personaId: 'admin-gotadorada', empresaId: 'gota-dorada' },
    { email: 'chofer@gotadorada.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Chofer Gota Dorada 1', personaId: 'chofer-gotadorada-1', empresaId: 'gota-dorada' },
    { email: 'admin@cisternaselvalle.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Admin Cisternas El Valle', personaId: 'admin-cisternaselvalle', empresaId: 'cisternas-el-valle' },
    { email: 'chofer@cisternaselvalle.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Chofer Cisternas El Valle 1', personaId: 'chofer-cisternaselvalle-1', empresaId: 'cisternas-el-valle' },
    // Pozo Cangrejo Loco — segunda empresa asociada. Arranca SIN personal confirmado: su
    // Administrador arma la plantilla desde Ajustes → "Personal de la empresa" eligiendo
    // correos de este pool (o escribiendo uno nuevo), poniéndoles nombre y roles. Hasta que
    // los confirme, no aparecen en Despacho, Agenda, Contabilidad ni billeteras (contabilidad
    // en 0). Estos correos son solo el pool disponible; el aislamiento por empresaId sigue
    // siendo estricto (ver actualizarSelectorEmpresa() y plantillaEmpresas más abajo).
    { email: 'admin1@pozocangrejoloco.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Admin 1 (Pozo Cangrejo Loco)', empresaId: 'pozo-cangrejo-loco' },
    { email: 'admin2@pozocangrejoloco.pe', password: 'admin2026', rol: 'Administrador', nombre: 'Admin 2 (Pozo Cangrejo Loco)', empresaId: 'pozo-cangrejo-loco' },
    { email: 'chofer1@pozocangrejoloco.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Chofer 1 (Pozo Cangrejo Loco)', empresaId: 'pozo-cangrejo-loco' },
    { email: 'chofer2@pozocangrejoloco.pe', password: 'chofer2026', rol: 'Chofer', nombre: 'Chofer 2 (Pozo Cangrejo Loco)', empresaId: 'pozo-cangrejo-loco' },
    { email: 'promotor1@pozocangrejoloco.pe', password: 'promotor2026', rol: 'Promotor', nombre: 'Promotor 1 (Pozo Cangrejo Loco)', empresaId: 'pozo-cangrejo-loco' }
  ];
  function buscarCredencial(email){
    var norm = String(email || '').trim().toLowerCase();
    return CREDENCIALES_PERSONAL.find(function(c){ return c.email === norm; }) || null;
  }

  /* ==========================================================================
     Personas promotoras — TODO el personal puede aparecer en "Conseguido por /
     Promotor" (Administradores y Choferes incluidos, no solo Promotores), y a
     cada uno se le liquida su comisión del 5% en su propia billetera cuando trae
     un cliente/viaje. Como Piero/Frank/Shimo tienen dos cuentas (Admin y Chofer),
     agrupamos por "persona" (una fila aquí = una persona real, con los correos de
     TODAS sus cuentas) para que su comisión de promotor sea una sola, sin importar
     con cuál de sus cuentas haya iniciado sesión quien consulta.
     pedidos.promotorEmail guarda el id de esta lista (ej. "piero", "ronald") desde
     este cambio en adelante; perteneceAPersona() también reconoce el formato viejo
     (un correo de promotor puntual) para no perder los pedidos ya registrados.
     ========================================================================== */
  var PERSONAS = [
    { id: 'watercore-admin', nombre: 'Equipo WaterCore Space (Admin)', emails: ['admin@watercorespace.pe'] },
    { id: 'piero', nombre: 'Piero (Admin / Chofer / SuperAdmin)', emails: ['admin1@kunturmasha.pe', 'chofer1@kunturmasha.pe', 'piero@watercorespace.pe'] },
    { id: 'frank', nombre: 'Frank (Admin / Chofer)', emails: ['admin2@kunturmasha.pe', 'chofer2@kunturmasha.pe'] },
    { id: 'shimo', nombre: 'Shimo (Admin / Chofer)', emails: ['admin3@kunturmasha.pe', 'chofer3@kunturmasha.pe'] },
    { id: 'ronald', nombre: 'Ronald (Promotor)', emails: ['promotor1@kunturmasha.pe'] },
    { id: 'jherson', nombre: 'Jherson (Promotor)', emails: ['promotor2@kunturmasha.pe'] },
    { id: 'promotor3', nombre: 'Promotor 3', emails: ['promotor3@kunturmasha.pe'] },
    { id: 'promotor4', nombre: 'Promotor 4', emails: ['promotor4@kunturmasha.pe'] },
    { id: 'promotor5', nombre: 'Promotor 5', emails: ['promotor5@kunturmasha.pe'] },
    { id: 'admin-aquatrujillo', nombre: 'Admin AquaTrujillo', emails: ['admin@aquatrujillo.pe'] },
    { id: 'chofer-aquatrujillo-1', nombre: 'Chofer AquaTrujillo 1', emails: ['chofer@aquatrujillo.pe'] },
    { id: 'admin-gotadorada', nombre: 'Admin Gota Dorada', emails: ['admin@gotadorada.pe'] },
    { id: 'chofer-gotadorada-1', nombre: 'Chofer Gota Dorada 1', emails: ['chofer@gotadorada.pe'] },
    { id: 'admin-cisternaselvalle', nombre: 'Admin Cisternas El Valle', emails: ['admin@cisternaselvalle.pe'] },
    { id: 'chofer-cisternaselvalle-1', nombre: 'Chofer Cisternas El Valle 1', emails: ['chofer@cisternaselvalle.pe'] }
  ];
  function personaDeCredencial(cred){
    if(!cred) return null;
    return PERSONAS.find(function(pe){ return pe.id === cred.personaId; }) || null;
  }
  // Reconoce si un pedido quedó "conseguido por" esta persona — acepta tanto el id de
  // persona (formato actual) como, para pedidos viejos, un correo suyo directamente.
  function perteneceAPersona(valorGuardado, persona){
    if(!valorGuardado || !persona) return false;
    return valorGuardado === persona.id || persona.emails.indexOf(valorGuardado) !== -1;
  }
  // Traduce lo que haya guardado en pedidos.promotorEmail (id de persona actual, o un
  // correo suelto de antes de este cambio) al id de persona para preseleccionar el
  // <select id="conseguidoPor"> al editar un pedido.
  function resolverPersonaId(valorGuardado){
    if(!valorGuardado) return '';
    var porId = PERSONAS.find(function(pe){ return pe.id === valorGuardado; });
    if(porId) return porId.id;
    var porEmail = PERSONAS.find(function(pe){ return pe.emails.indexOf(valorGuardado) !== -1; });
    return porEmail ? porEmail.id : '';
  }
  // Igual que nombreMostrado(), pero para una persona con varias cuentas: usa el primer
  // nombre editado que encuentre entre sus correos, si hay alguno.
  function nombrePersonaMostrado(persona){
    for(var i = 0; i < persona.emails.length; i++){
      var editado = nombresPerfil[persona.emails[i]];
      if(editado && editado.trim()) return editado.trim();
    }
    return persona.nombre;
  }

  // Ajustes manuales de saldo/días trabajados que no vienen de un pedido real en el sistema
  // (ej. arrastrados de antes de este cambio, o acordados aparte) — se suman al saldo derivado
  // de pedidos.Completado en Mi Perfil, y su fecha también cuenta como "día trabajado". "tipo"
  // separa las dos billeteras que puede tener una misma persona (ej. Piero: 'chofer' por
  // manejar, 'promotor' por traer clientes) — sin esto, un correo que aparece en las dos listas
  // (chofer1@... es cuenta de Chofer Y parte de la persona "piero" en PERSONAS) contaría el
  // mismo ajuste dos veces. Ver calcularComisionesChofer()/calcularComisionesPromotor().
  var AJUSTES_HISTORICOS = [
    { email: 'chofer1@kunturmasha.pe', fecha: '2026-08-21', monto: 110.00, concepto: 'Saldo acumulado registrado', tipo: 'chofer' },
    { email: 'promotor1@kunturmasha.pe', fecha: '2026-08-21', monto: 70.00, concepto: 'Saldo acumulado registrado', tipo: 'promotor' }
  ];

  // Nombre "visible" editable por la propia persona desde Mi Perfil — se guarda por correo en
  // este navegador (localStorage), NUNCA reemplaza cred.nombre (el que usan el <select> de
  // Chofer, "Conseguido por" y el cálculo de comisiones): cambiar cómo te llamas en pantalla no
  // debe poder desconectar tus viajes ya registrados de tu billetera.
  function cargarNombresPerfil(){
    try{
      var raw = localStorage.getItem(PERFIL_NOMBRES_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    }catch(e){ return {}; }
  }
  var nombresPerfil = cargarNombresPerfil();
  function guardarNombrePerfil(email, nombre){
    nombresPerfil[email] = nombre;
    try{ localStorage.setItem(PERFIL_NOMBRES_KEY, JSON.stringify(nombresPerfil)); }catch(e){}
  }
  function nombreMostrado(cred){
    if(!cred) return '';
    var editado = nombresPerfil[cred.email];
    return (editado && editado.trim()) ? editado.trim() : cred.nombre;
  }

  var VISTAS_POR_ROL = {
    admin: { tabs: ['home', 'agenda', 'cotizar', 'hub', 'agendar', 'ayudante', 'contabilidad', 'perfil', 'ajustes'], defaultView: 'home' },
    cliente: { tabs: ['home', 'agenda', 'cotizar', 'hub'], defaultView: 'agenda' },
    chofer: { tabs: ['home', 'agenda', 'perfil'], defaultView: 'agenda' },
    promotor: { tabs: ['home', 'agendar', 'perfil'], defaultView: 'agendar' },
    // Nuevo rol operativo: checklist de descarga (conexión de manguera, descarga completada,
    // reporte de incidencias) — ver renderAyudante(). También ve Mi Perfil (sin comisión propia
    // salvo que además tenga un personaId como promotor).
    ayudante: { tabs: ['home', 'ayudante', 'perfil'], defaultView: 'ayudante' }
  };

  // Rol activo por defecto: 'cliente' — la app arranca directo en modo cliente (sin
  // login, sin pantalla que tape nada) y solo cambia si hay una sesión de personal
  // guardada (ver cargarSesionPersonal()) o alguien inicia sesión desde el modal.
  var rolActivo = 'cliente';
  function guardarRol(r){
    rolActivo = r;
  }

  /* ==========================================================================
     Marketplace multiempresa (rama "demo"). "WaterCore Space" es la marca paraguas / Sede
     Central que administra toda la red: opera el Hub Central/subasta, adjudica solicitudes
     y retiene su comisión de intermediación (esSedeCentral). Cada una de las 5 empresas
     asociadas (Kunturmasha incluida — ya NO es la marca principal, es una empresa asociada
     más) tiene su propio "sub-espacio": su propia agenda (ver ordenarDelDia()/renderStats()),
     su propia Contabilidad (ver pedidosDelPeriodo()/gastosDelPeriodo()) y su propia flota de
     choferes (ver poblarSelectChofer()) — todo filtrado por empresaActivaId, sin duplicar el
     código de esas vistas. El switch de empresa (topbar, solo Administrador) simula entrar al
     espacio de cada empresa; solo las cuentas con accesoGlobal (equipo WaterCore Space) pueden
     moverse libremente entre todas — cualquier otra cuenta queda fija en la suya (aislamiento
     estricto, ver actualizarSelectorEmpresa()).
     Kunturmasha y Pozo Cangrejo Loco tienen plantilla completa (varios administradores,
     choferes y promotores); AquaTrujillo, Gota Dorada y Cisternas El Valle arrancan con un
     administrador y un chofer reales (CREDENCIALES_PERSONAL);
     "choferesDemo" solo es un respaldo por si alguna empresa todavía no tiene chofer dado
     de alta con cuenta propia (ver poblarSelectChofer()).
     ========================================================================== */
  var EMPRESA_ACTIVA_KEY = 'kunturmasha_empresa_activa_v1';
  // Único punto de verdad para la tasa de comisión estándar (5%) — antes vivía repetida como
  // 0.05 en cada empresa Y en calcularComisionesChofer()/calcularComisionesPromotor(), lo que
  // permitía que un cambio de tasa quedara desincronizado entre la comisión de Sede Central y
  // la de choferes/promotores. Ahora las tres se calculan desde esta misma constante.
  var COMISION_ESTANDAR = 0.05;
  var EMPRESAS = [
    { id: 'watercore-space', nombre: 'WaterCore Space', esSedeCentral: true, comisionPeaje: COMISION_ESTANDAR, choferesDemo: [] },
    { id: 'kunturmasha', nombre: 'Kunturmasha', esSedeCentral: false, comisionPeaje: COMISION_ESTANDAR, choferesDemo: [] },
    { id: 'pozo-cangrejo-loco', nombre: 'Pozo Cangrejo Loco', esSedeCentral: false, comisionPeaje: COMISION_ESTANDAR, choferesDemo: [] },
    { id: 'aqua-trujillo', nombre: 'AquaTrujillo', esSedeCentral: false, comisionPeaje: COMISION_ESTANDAR, choferesDemo: ['Chofer AquaTrujillo 1'] },
    { id: 'gota-dorada', nombre: 'Gota Dorada', esSedeCentral: false, comisionPeaje: COMISION_ESTANDAR, choferesDemo: ['Chofer Gota Dorada 1'] },
    { id: 'cisternas-el-valle', nombre: 'Cisternas El Valle', esSedeCentral: false, comisionPeaje: COMISION_ESTANDAR, choferesDemo: ['Chofer Cisternas El Valle 1'] }
  ];

  /* ==========================================================================
     Directorio Central de Accesos (solo visible para piero@watercorespace.pe, ver
     renderDirectorioCentral()): 150 cuentas de prueba — 10 para cada uno de los 3 roles
     operativos (Administrador, Chofer, Ayudante) en cada una de las 5 empresas asociadas
     (no Sede Central: WaterCore Space no tiene su propia flota). Se generan una sola vez al
     cargar la página, no en cada render, y se agregan a CREDENCIALES_PERSONAL para que sean
     cuentas de verdad (se puede iniciar sesión con cualquiera): así Piero puede copiarle a
     una empresa credenciales ya listas para su Administrador/Chofer/Ayudante en vez de
     inventarlas a mano cada vez. La contraseña (8 dígitos) sale de un hash simple del correo
     — no es criptográficamente aleatoria, pero es fija: no cambia entre recargas de la
     página, como el resto de CREDENCIALES_PERSONAL.
     ========================================================================== */
  var DIRECTORIO_APELLIDOS = ['garcia', 'rodriguez', 'vargas', 'soto', 'quispe', 'flores', 'ramos', 'castillo', 'medina', 'torres'];
  var DIRECTORIO_PALABRAS_ROL = {
    Administrador: ['operaciones', 'gestion', 'oficina', 'control', 'coordinacion', 'despacho', 'planilla', 'contable', 'logistica', 'administracion'],
    Chofer: ['ruta.norte', 'ruta.sur', 'ruta.este', 'cisterna.uno', 'cisterna.dos', 'flota.a', 'flota.b', 'reparto', 'entrega', 'camion'],
    Ayudante: ['tanque', 'manguera', 'apoyo.campo', 'campo', 'descarga', 'soporte', 'cuadrilla', 'obra', 'servicio', 'turno']
  };
  function capitalizarPalabra(s){
    return s.split(/[.\s]+/).map(function(w){ return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  // Hash simple y determinístico (no Math.random, para que el resultado sea siempre el mismo)
  // — convierte el correo en 8 dígitos, rellenando con ceros a la izquierda si hace falta.
  function passwordOchoDigitos(seed){
    var h = 0;
    for(var i = 0; i < seed.length; i++){ h = (h * 31 + seed.charCodeAt(i)) >>> 0; }
    var s = String(h % 100000000);
    while(s.length < 8) s = '0' + s;
    return s;
  }
  function generarDirectorioCentral(){
    var cuentas = [];
    EMPRESAS.filter(function(e){ return !e.esSedeCentral; }).forEach(function(empresa){
      var dominio = (empresa.id + '.pe').replace(/-/g, '');
      ['Administrador', 'Chofer', 'Ayudante'].forEach(function(rol){
        for(var i = 0; i < 10; i++){
          var apellido = DIRECTORIO_APELLIDOS[i];
          var palabra = DIRECTORIO_PALABRAS_ROL[rol][i];
          // Alterna el orden ("palabra.apellido" / "apellido.palabra") para que las 150
          // cuentas no luzcan todas con el mismo patrón — ej. "operaciones.garcia@..." y
          // "soto.ruta.norte@..." conviven en la misma matriz.
          var local = (i % 2 === 0) ? (palabra + '.' + apellido) : (apellido + '.' + palabra);
          var email = local + '@' + dominio;
          cuentas.push({
            email: email, password: passwordOchoDigitos(email), rol: rol,
            nombre: capitalizarPalabra(apellido) + ' ' + capitalizarPalabra(palabra),
            empresaId: empresa.id, directorioCentral: true
          });
        }
      });
    });
    return cuentas;
  }
  CREDENCIALES_PERSONAL = CREDENCIALES_PERSONAL.concat(generarDirectorioCentral());

  /* ==========================================================================
     Plantilla de personal por empresa (editable desde Ajustes → "Personal de la
     empresa"). CREDENCIALES_PERSONAL es solo el POOL de correos que puede tener
     una empresa (los fijos del código + las 150 del Directorio Central + los que
     el Administrador escriba a mano). Una persona NO cuenta como personal activo
     —no sale en el <select> de Chofer del Despacho, ni en "Conseguido por", ni en
     las tablas de Contabilidad/billeteras— hasta que el Administrador de esa
     empresa (o Piero) la confirma aquí, poniéndole nombre y uno o más roles.
     Con dos o más roles, esa cuenta puede alternar entre ellos desde el selector
     rápido de rol de la cabecera (cred.roles, ver rolesDeCredencial()).
     Se guarda solo en este navegador (localStorage) — igual de "best-effort" que
     el checklist del Ayudante; no hay tabla en Supabase para esto todavía.
     Semilla: cada empresa asociada arranca con su personal fijo ya confirmado,
     EXCEPTO Pozo Cangrejo Loco, que arranca vacía (su Administrador la arma).
     ========================================================================== */
  var PLANTILLA_EMPRESAS_KEY = 'kunturmasha_plantilla_empresas_v1';
  var PLR_ROLES = ['admin', 'chofer', 'ayudante', 'promotor'];
  var PLR_INT_A_DB = { admin: 'Administrador', chofer: 'Chofer', ayudante: 'Ayudante', promotor: 'Promotor' };
  var PLR_DB_A_INT = { Administrador: 'admin', Chofer: 'chofer', Ayudante: 'ayudante', Promotor: 'promotor', Cliente: 'cliente' };
  var PLR_ETIQUETA = { admin: 'Administrador', chofer: 'Chofer', ayudante: 'Ayudante', promotor: 'Promotor' };
  function normalizarCorreo(x){ return String(x || '').trim().toLowerCase(); }
  function cargarPlantillaEmpresas(){
    try{ var o = JSON.parse(localStorage.getItem(PLANTILLA_EMPRESAS_KEY) || 'null'); if(o && typeof o === 'object') return o; }catch(e){}
    return null;
  }
  function plantillaSemilla(){
    var out = {};
    EMPRESAS.forEach(function(e){ if(!e.esSedeCentral) out[e.id] = {}; });
    CREDENCIALES_PERSONAL.forEach(function(c){
      if(c.directorioCentral || c.accesoGlobal) return;   // pool generado / equipo sede: no se pre-confirman
      if(!out[c.empresaId]) return;                        // solo empresas asociadas
      if(c.empresaId === 'pozo-cangrejo-loco') return;     // arranca vacía
      var entry = out[c.empresaId][c.email] || { nombre: c.nombre, roles: [] };
      var lista = (Array.isArray(c.roles) && c.roles.length) ? c.roles.slice() : [PLR_DB_A_INT[c.rol] || 'admin'];
      lista.forEach(function(r){ if(entry.roles.indexOf(r) === -1) entry.roles.push(r); });
      entry.nombre = c.nombre;
      out[c.empresaId][c.email] = entry;
    });
    return out;
  }
  var plantillaEmpresas = cargarPlantillaEmpresas() || plantillaSemilla();
  function guardarPlantillaEmpresas(){
    try{ localStorage.setItem(PLANTILLA_EMPRESAS_KEY, JSON.stringify(plantillaEmpresas)); }catch(e){}
  }
  guardarPlantillaEmpresas(); // persiste la semilla la primera vez

  // Garantiza una PERSONA (ver PERSONAS) para un correo confirmado que no tuviera una —
  // así su comisión de "Conseguido por / Promotor" se puede calcular igual que la del
  // personal fijo. Las creadas aquí llevan dePlantilla:true y siguen el nombre asignado.
  function asegurarPersonaPorCorreo(email, nombre){
    email = normalizarCorreo(email);
    var p = PERSONAS.find(function(pe){ return pe.emails.indexOf(email) !== -1; });
    if(p) return p;
    p = { id: 'plr-' + passwordOchoDigitos(email), nombre: nombre || email, emails: [email], dePlantilla: true };
    PERSONAS.push(p);
    return p;
  }
  // Vuelca la plantilla sobre el pool de credenciales: fija cred.roles / cred.nombre y
  // marca cred.enPlantilla. Si un correo confirmado no existía en el pool (lo escribió el
  // Administrador a mano), se sintetiza una credencial real para que pueda iniciar sesión.
  // La contraseña sale de entry.password si el Administrador la escribió (alta manual, hoy
  // solo Pozo Cangrejo Loco); si no, se deriva del correo como en el Directorio Central.
  // Se llama al cargar y cada vez que el Administrador guarda un cambio en Ajustes.
  function aplicarPlantillaACredenciales(){
    Object.keys(plantillaEmpresas).forEach(function(empresaId){
      var roster = plantillaEmpresas[empresaId] || {};
      Object.keys(roster).forEach(function(emailRaw){
        var email = normalizarCorreo(emailRaw);
        var entry = roster[emailRaw];
        var rolesArr = PLR_ROLES.filter(function(r){ return (entry.roles || []).indexOf(r) !== -1; });
        if(!rolesArr.length) rolesArr = ['admin'];
        var rolDb = PLR_INT_A_DB[rolesArr[0]] || 'Administrador';
        var cred = buscarCredencial(email);
        if(!cred){
          cred = { email: email, password: entry.password || passwordOchoDigitos(email), rol: rolDb, nombre: entry.nombre || email, empresaId: empresaId, personalPlantilla: true };
          CREDENCIALES_PERSONAL.push(cred);
        }
        if(entry.password) cred.password = entry.password;
        cred.rol = rolDb;
        cred.roles = rolesArr;
        cred.nombre = entry.nombre || cred.nombre;
        cred.enPlantilla = true;
        var persona = asegurarPersonaPorCorreo(email, cred.nombre);
        if(!cred.personaId) cred.personaId = persona.id;
        if(persona.dePlantilla) persona.nombre = cred.nombre;
      });
    });
  }
  aplicarPlantillaACredenciales();

  function estaEnPlantilla(email, empresaId){
    var r = plantillaEmpresas[empresaId];
    return !!(r && r[normalizarCorreo(email)]);
  }
  // Personal confirmado de una empresa: [{ email, nombre, roles[], cred }], ordenado por nombre.
  function rosterDeEmpresa(empresaId){
    var r = plantillaEmpresas[empresaId] || {};
    return Object.keys(r).map(function(email){
      var cred = buscarCredencial(email);
      return { email: email, nombre: r[email].nombre || (cred && cred.nombre) || email, roles: (r[email].roles || []).slice(), cred: cred };
    }).sort(function(a, b){ return a.nombre.localeCompare(b.nombre); });
  }
  // Personas (para "Conseguido por / Promotor" y su comisión) con al menos un correo
  // confirmado en la plantilla de esa empresa — nadie de otras empresas se cuela.
  function personasDeEmpresa(empresaId){
    var r = plantillaEmpresas[empresaId] || {};
    var emails = Object.keys(r);
    return PERSONAS.filter(function(pe){ return pe.emails.some(function(e){ return emails.indexOf(e) !== -1; }); });
  }
  // Pool de correos asignables de una empresa (fijos + Directorio Central), sin el equipo sede.
  function poolCorreosDe(empresaId){
    return CREDENCIALES_PERSONAL
      .filter(function(c){ return c.empresaId === empresaId && !c.accesoGlobal; })
      .map(function(c){ return { email: c.email, rol: c.rol, directorio: !!c.directorioCentral }; })
      .sort(function(a, b){ return a.email.localeCompare(b.email); });
  }

  function buscarEmpresa(id){
    return EMPRESAS.find(function(e){ return e.id === id; }) || EMPRESAS[0];
  }

  /* ==========================================================================
     Tinte de marca por empresa afiliada (Ajustes → "🎨 Color de la empresa").
     Solo cambia --tint-h / --tint-s en <html>; toda la piel de la web se
     rederiva desde el CSS (:root). Por defecto (clientes, sin sesión, y la
     Sede Central) manda el celeste pastel del :root — TINTE_DEFECTO. Cada
     empresa asociada puede fijar su propio tono con la rueda de color, y se
     aplica cuando su personal tiene sesión iniciada en ese espacio.
     Guardado solo en este navegador (localStorage), como plantillaEmpresas.
     ========================================================================== */
  var TINTE_EMPRESAS_KEY = 'kunturmasha_tinte_empresas_v1';
  var TINTE_DEFECTO = { h: 202, s: 62 };
  function cargarTinteEmpresas(){
    try{ var o = JSON.parse(localStorage.getItem(TINTE_EMPRESAS_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch(e){ return {}; }
  }
  var tinteEmpresas = cargarTinteEmpresas();
  function guardarTinteEmpresas(){
    try{ localStorage.setItem(TINTE_EMPRESAS_KEY, JSON.stringify(tinteEmpresas)); }catch(e){}
  }
  function tinteDeEmpresa(empresaId){
    var t = tinteEmpresas[empresaId];
    if(t && isFinite(t.h) && isFinite(t.s)) return { h: t.h, s: t.s };
    return { h: TINTE_DEFECTO.h, s: TINTE_DEFECTO.s };
  }
  // Aplica un tinte {h,s} a <html>. Si no se pasa uno, decide según contexto:
  // con sesión de personal en una empresa asociada → el tinte de esa empresa;
  // en cualquier otro caso (cliente, Sede Central) → el celeste por defecto.
  function aplicarTinte(t){
    var root = document.documentElement;
    root.style.setProperty('--tint-h', String(t.h));
    root.style.setProperty('--tint-s', t.s + '%');
  }
  function aplicarTinteSegunContexto(animar){
    var empresa = buscarEmpresa(empresaActivaId);
    var usaEmpresa = (typeof usuarioActual !== 'undefined' && usuarioActual) && !empresa.esSedeCentral;
    var t = usaEmpresa ? tinteDeEmpresa(empresa.id) : { h: TINTE_DEFECTO.h, s: TINTE_DEFECTO.s };
    if(animar){
      document.documentElement.classList.add('tinte-animado');
      setTimeout(function(){ document.documentElement.classList.remove('tinte-animado'); }, 650);
    }
    aplicarTinte(t);
  }

  /* ==========================================================================
     Política de pagos configurable por empresa (Mi Perfil del Administrador, ver
     renderConfigPagos()). Antes el sueldo de chofer/ayudante por viaje era fijo y
     escalonado para TODAS las empresas (ver manoDeObra()) y la comisión de promotor era
     un 5% fijo global (COMISION_ESTANDAR). Ahora cada empresa puede definir su propia
     estructura: modalidad de pago a chofer/ayudante (sueldo fijo diario / pago fijo por
     viaje / % por viaje) y si habilita o no comisión de promotor (y con qué modalidad).
     Si una empresa nunca configuró nada, configPagosDe() devuelve un modo especial
     "legado" que reproduce EXACTAMENTE el comportamiento de siempre — ninguna empresa
     ve cambiar sus números ya mostrados sin que su Administrador toque este panel.
     ========================================================================== */
  var CONFIG_EMPRESAS_KEY = 'kunturmasha_config_empresas_v1';
  function cargarConfigEmpresas(){
    try{ var obj = JSON.parse(localStorage.getItem(CONFIG_EMPRESAS_KEY) || '{}'); return (obj && typeof obj === 'object') ? obj : {}; }
    catch(e){ return {}; }
  }
  var configEmpresas = cargarConfigEmpresas();
  function guardarConfigEmpresas(){
    try{ localStorage.setItem(CONFIG_EMPRESAS_KEY, JSON.stringify(configEmpresas)); }catch(e){}
    if(supaListo) empujarConfigEmpresa(empresaActivaId);
  }
  // "legado": sentinel interno (nunca aparece como opción en el <select>) que reproduce el
  // sueldo escalonado de siempre (chofer S/.20/10, ayudante S/.10/5) y la comisión de
  // promotor del 5% global — es lo que se usa mientras nadie haya guardado nada.
  function configPagosPorDefecto(){
    return {
      choferModalidad: 'legado', choferMonto: 0,
      ayudanteModalidad: 'legado', ayudanteMonto: 0,
      promotorHabilitado: true, promotorModalidad: 'porcentaje_viaje', promotorMonto: COMISION_ESTANDAR * 100
    };
  }
  function configPagosDe(empresaId){
    var guardada = configEmpresas[empresaId];
    return guardada ? Object.assign(configPagosPorDefecto(), guardada) : configPagosPorDefecto();
  }
  function guardarConfigPagos(empresaId, cfg){
    configEmpresas[empresaId] = cfg;
    guardarConfigEmpresas();
    if(empresaId === empresaActivaId) actualizarUIPagosSegunEmpresa();
  }
  // ---- Sincronización con Supabase (config_empresas) — igual de "best-effort" que el resto
  // de la app: si la tabla no existe todavía (no corrieron el supabase_schema.sql más
  // reciente) o falla la red, la app sigue funcionando solo con localStorage, sin errores
  // visibles para quien la usa. ----
  function configARemoto(empresaId, cfg){
    return {
      empresa_id: empresaId,
      chofer_modalidad: cfg.choferModalidad, chofer_monto: Number(cfg.choferMonto) || 0,
      ayudante_modalidad: cfg.ayudanteModalidad, ayudante_monto: Number(cfg.ayudanteMonto) || 0,
      promotor_habilitado: !!cfg.promotorHabilitado,
      promotor_modalidad: cfg.promotorModalidad, promotor_monto: Number(cfg.promotorMonto) || 0
    };
  }
  function configDesdeRemoto(r){
    return {
      choferModalidad: r.chofer_modalidad, choferMonto: r.chofer_monto,
      ayudanteModalidad: r.ayudante_modalidad, ayudanteMonto: r.ayudante_monto,
      promotorHabilitado: r.promotor_habilitado, promotorModalidad: r.promotor_modalidad, promotorMonto: r.promotor_monto
    };
  }
  function empujarConfigEmpresa(empresaId){
    if(!supa || !supaListo) return;
    supa.from('config_empresas').upsert(configARemoto(empresaId, configPagosDe(empresaId)), { onConflict: 'empresa_id' })
      .then(function(res){ if(res.error) console.warn('Supabase: no se pudo guardar config_empresas', res.error.message); })
      .catch(function(err){ console.warn('Supabase: fallo de red al guardar config_empresas', err); });
  }
  // Se llama una vez al conectar con Supabase (ver iniciarSupabase()) — trae la política de
  // pagos de cada empresa que ya la haya configurado desde otro dispositivo. Si esta empresa
  // solo tiene configuración local todavía sin sincronizar, Supabase manda (se asume que la
  // fila remota es la más reciente entre dispositivos, igual que pedidos/gastos).
  function cargarConfigEmpresasRemoto(){
    if(!supa) return;
    supa.from('config_empresas').select('*').then(function(res){
      if(res.error || !res.data) return; // tabla ausente u otro problema: se queda con lo local
      res.data.forEach(function(fila){ configEmpresas[fila.empresa_id] = configDesdeRemoto(fila); });
      try{ localStorage.setItem(CONFIG_EMPRESAS_KEY, JSON.stringify(configEmpresas)); }catch(e){}
      actualizarUIPagosSegunEmpresa();
      if(vistaActual === 'perfil') renderPerfil();
    }).catch(function(){ /* sin red o tabla ausente: se queda con lo local */ });
  }
  var ETIQUETA_MODALIDAD_PAGO = { legado: 'según el sueldo escalonado de siempre', fijo_dia: 'sueldo fijo diario', fijo_viaje: 'pago fijo por viaje', porcentaje_viaje: 'porcentaje por viaje' };
  function describirPago(modalidad, monto){
    if(modalidad === 'fijo_dia') return 'S/. ' + (Number(monto) || 0).toFixed(2) + '/día';
    if(modalidad === 'fijo_viaje') return 'S/. ' + (Number(monto) || 0).toFixed(2) + '/viaje';
    if(modalidad === 'porcentaje_viaje') return (Number(monto) || 0) + '%/viaje';
    return 'el escalonado de siempre (> S/.150: chofer S/.20 + ayudante S/.10 · resto: chofer S/.10 + ayudante S/.5)';
  }
  // Refleja en el formulario de Despacho la política de pagos de la empresa activa: el aviso
  // de sueldo (dinámico según lo configurado, ver renderConfigPagos()) y si esta empresa
  // deshabilitó promotores — en ese caso el campo "Conseguido por / Promotor" se oculta del
  // todo (no solo se deja vacío) para que no se pueda elegir un promotor que no se le paga.
  function actualizarUIPagosSegunEmpresa(){
    var cfg = configPagosDe(empresaActivaId);
    var notaMo = document.getElementById('notaManoDeObra');
    if(notaMo){
      notaMo.textContent = cfg.choferModalidad === 'legado' && cfg.ayudanteModalidad === 'legado'
        ? 'Sueldo por viaje completado, según el precio acordado: más de S/. 150 → chofer S/. 20.00 + ayudante S/. 10.00 · S/. 150 o menos → chofer S/. 10.00 + ayudante S/. 5.00 — se calcula solo, no hace falta registrarlo en Gastos.'
        : 'Sueldo configurado por esta empresa — chofer: ' + describirPago(cfg.choferModalidad, cfg.choferMonto) + ' · ayudante: ' + describirPago(cfg.ayudanteModalidad, cfg.ayudanteMonto) + '. Se calcula solo, no hace falta registrarlo en Gastos.';
    }
    var grupo = document.getElementById('groupConseguidoPor');
    if(grupo) grupo.hidden = !cfg.promotorHabilitado;
    var notaPromotor = document.getElementById('notaComisionPromotor');
    if(notaPromotor && cfg.promotorHabilitado){
      notaPromotor.textContent = 'Quién trajo a este cliente — al completarse el viaje, esa persona recibe ' + describirPago(cfg.promotorModalidad, cfg.promotorMonto) + ' en su "Mi Perfil / Billetera". Si lo registra un promotor con sesión iniciada, este campo se autocompleta solo (igual se puede cambiar).';
    }
  }
  function cargarEmpresaActiva(){
    try{
      var id = localStorage.getItem(EMPRESA_ACTIVA_KEY);
      return (id && buscarEmpresa(id).id === id) ? id : 'kunturmasha';
    }catch(e){ return 'kunturmasha'; }
  }
  var empresaActivaId = cargarEmpresaActiva();

  function cargarNombrePromotor(){
    try{ return localStorage.getItem(PROMOTOR_NOMBRE_KEY) || ''; }catch(e){ return ''; }
  }
  var nombrePromotor = cargarNombrePromotor();
  function guardarNombrePromotor(n){
    nombrePromotor = n;
    try{ localStorage.setItem(PROMOTOR_NOMBRE_KEY, n); }catch(e){}
  }

  // Mapa { idDePedido: nombreDelPromotor } — puramente local a este navegador. El login
  // ahora es real (Supabase Auth) y el permiso para crear/editar pedidos como Promotor
  // también (ver política "pedidos_insert_staff" en supabase_schema.sql), pero la tabla
  // pedidos en sí no tiene una columna para "quién lo afilió" — agregarla es un cambio de
  // esquema fuera del alcance de este ajuste. Por eso "Mis Pedidos como Promotor" solo
  // reconoce lo registrado desde este mismo navegador, no desde cualquier dispositivo
  // donde ese mismo promotor haya iniciado sesión.
  function cargarAfiliaciones(){
    try{
      var raw = localStorage.getItem(AFILIACIONES_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    }catch(e){ return {}; }
  }
  var afiliaciones = cargarAfiliaciones();
  function guardarAfiliaciones(){
    try{ localStorage.setItem(AFILIACIONES_KEY, JSON.stringify(afiliaciones)); }catch(e){}
  }

  // Debounce genérico: agrupa llamadas seguidas (tipeo en un buscador, varios cambios
  // de fecha seguidos, etc.) en una sola ejecución tras "ms" de silencio, para no
  // recalcular/repintar en cada tecla.
  function debounce(fn, ms){
    var temporizador;
    return function(){
      var args = arguments, ctx = this;
      clearTimeout(temporizador);
      temporizador = setTimeout(function(){ fn.apply(ctx, args); }, ms);
    };
  }

  // Firma barata de una lista de pedidos/gastos (ordenada por id, para que el orden de
  // llegada no cuente como "cambio"), usada para detectar cuando Supabase Realtime nos
  // devuelve un eco de un cambio que nosotros mismos acabamos de subir: si el contenido
  // es idéntico al que ya tenemos en memoria, no hay nada que repintar.
  // JSON.stringify normal depende del ORDEN en que se insertaron las claves del objeto:
  // un pedido creado localmente (datos = {fecha, cliente, ...}) y ese mismo pedido tal
  // como vuelve desde Supabase (pedidoDesdeRemoto, que arma sus claves en otro orden)
  // pueden tener exactamente los mismos valores y aun así producir strings distintos —
  // eso hacía que firmaLista() creyera que "cambió algo" en cada eco de Realtime aunque
  // no hubiera ningún cambio real, disparando repintados de sobra (una de las causas del
  // temblor/salto de layout). stringifyEstable ordena las claves alfabéticamente en todos
  // los niveles antes de comparar, así el orden de construcción del objeto ya no importa.
  function stringifyEstable(valor){
    if(valor === null || typeof valor !== 'object') return JSON.stringify(valor);
    if(Array.isArray(valor)) return '[' + valor.map(stringifyEstable).join(',') + ']';
    var claves = Object.keys(valor).sort();
    return '{' + claves.map(function(k){ return JSON.stringify(k) + ':' + stringifyEstable(valor[k]); }).join(',') + '}';
  }
  function firmaLista(lista){
    var copia = lista.slice().sort(function(a, b){ return (a.id || '').localeCompare(b.id || ''); });
    return copia.map(stringifyEstable).join('|');
  }

  // Etapas del servicio que el chofer marca con un clic (control de tiempos / eficiencia)
  var ETAPAS = ['Llenado de agua', 'Traslado al destino', 'Descarga en destino'];

  // Flujo operativo de un pedido, en orden: cada click en "Avanzar" mueve al pedido
  // al siguiente estado de esta lista. Ver la guía visual (guia-flujo / leyenda de
  // estados) en la Agenda. Se definen aquí arriba (antes de cargarPedidos) porque
  // migrarPedidos() los necesita para sanear el campo "estado" de cualquier pedido
  // que entre al sistema (localStorage, import de copia de seguridad, Supabase).
  var FLUJO_ESTADOS = ['Programado', 'Llenado', 'En Ruta', 'Descarga', 'Regresando a Base', 'Completado'];
  var ESTADOS_FALLIDOS = ['Cancelado', 'Retirado'];
  var ESTADOS_VALIDOS = FLUJO_ESTADOS.concat(ESTADOS_FALLIDOS);
  var ESTADOS_ABIERTOS = ['Programado', 'Llenado', 'En Ruta', 'Descarga', 'Regresando a Base']; // todo lo anterior a Completado (y no cancelado/retirado)
  function tiemposVacios(){
    return ETAPAS.map(function(){ return { inicio: null, fin: null }; });
  }
  function formatearHora(iso){
    if(!iso) return '';
    try{ return new Date(iso).toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit' }); }
    catch(e){ return ''; }
  }
  // Convierte una hora "HH:MM" en formato 24h (lo que guarda <input type="time">) a
  // texto de 12 horas con sufijo AM/PM, ej: "14:00" -> "02:00 PM". Se usa para mostrar
  // horaInicio/horaFin de forma legible en toda la app; el valor guardado internamente
  // sigue siendo "HH:MM" 24h (el formato nativo y sin ambigüedad de <input type="time">).
  function formatearHora12(hhmm){
    if(!hhmm) return '';
    var partes = String(hhmm).split(':');
    var h = parseInt(partes[0], 10);
    var m = partes[1] || '00';
    if(isNaN(h)) return hhmm;
    var periodo = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if(h12 === 0) h12 = 12;
    return String(h12).padStart(2,'0') + ':' + m + ' ' + periodo;
  }
  // Minutos transcurridos desde medianoche para una hora "HH:MM"; null si no es válida.
  function minutosDesdeMedianoche(hhmm){
    var partes = String(hhmm || '').split(':');
    var h = parseInt(partes[0], 10), m = parseInt(partes[1], 10);
    if(isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }
  // Suma (o resta) minutos a una hora "HH:MM", envolviendo dentro del mismo día (0–23:59).
  function sumarMinutosHora(hhmm, minutos){
    var base = minutosDesdeMedianoche(hhmm);
    if(base === null) return hhmm;
    var total = ((base + minutos) % 1440 + 1440) % 1440;
    var h = Math.floor(total / 60), m = total % 60;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  }
  function formatearDuracionMin(ms){
    if(ms === null || ms === undefined || isNaN(ms) || ms < 0) return '—';
    var totalMin = Math.round(ms / 60000);
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    return (h > 0 ? h + 'h ' : '') + m + 'm';
  }

  // Código único de cliente: se genera con el primer viaje del cliente y se reutiliza siempre que
  // se agende un pedido con el mismo nombre (comparación normalizada, sin mayúsculas ni espacios extra).
  function normalizarCliente(s){
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function obtenerCodigoParaCliente(nombre){
    var norm = normalizarCliente(nombre);
    if(!norm) return '';
    var existente = pedidos.find(function(p){ return p.codigoCliente && normalizarCliente(p.cliente) === norm; });
    if(existente) return existente.codigoCliente;
    var maxNum = 0;
    pedidos.forEach(function(p){
      var m = /^CLI-(\d+)$/.exec(p.codigoCliente || '');
      if(m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    return 'CLI-' + String(maxNum + 1).padStart(3, '0');
  }

  // Base de datos inicial en blanco: el sistema arranca sin pedidos de ejemplo.
  // siguienteId() y obtenerCodigoParaCliente() ya parten de 0 cuando no hay pedidos,
  // así que el primer pedido real será PED-01 y el primer cliente CLI-001.
  var PEDIDOS_INICIALES = [];

  // Corrige datos de versiones anteriores: fecha faltante, 'zona' renombrada a 'ubicacion',
  // chofer/ayudante/motivo/tiempos faltantes, código de cliente faltante, y asigna 'orden'
  // (posición manual en la agenda del día) a los que no lo tengan.
  /* ==========================================================================
     Saneo de texto en el BORDE de datos (defensa en profundidad contra XSS
     almacenado). La base de Supabase es escribible con la anon key pública, así
     que NADA de lo que llega en una fila —remota, de un backup importado o de
     localStorage escrito por una versión vieja— es de fiar. sanText() quita los
     caracteres con los que se abre una etiqueta o un atributo (< > " ' backtick
     barra) y los de control, neutraliza "javascript:" y recorta a un largo
     razonable. Se aplica en el normalizador de cada entidad que luego se pinta
     (pedidos, gastos, solicitudes, ofertas). El escape en cada sink de innerHTML
     y la CSP de vercel.json son las otras dos capas.
     ========================================================================== */
  function sanText(v, max){
    if(v === null || v === undefined) return v;
    var s = String(v)
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/[<>"'`\\]/g, ' ')
      .replace(/javascript:/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return s.slice(0, max || 400);
  }
  // Sanea in-place los campos de texto libre de un pedido.
  function sanearPedido(p){
    ['id','cliente','codigoCliente','ubicacion','telefono','chofer','ayudante',
     'tipoAlmacen','piso','dificultad','manguera','notas','estado','motivoCancelacion',
     'metodoPago','promotorEmail'].forEach(function(k){
      if(p[k] !== undefined && p[k] !== null) p[k] = sanText(p[k], k === 'notas' ? 800 : 200);
    });
    return p;
  }

  function migrarPedidos(datos){
    datos.forEach(function(p){
      sanearPedido(p);
      if(!p.fecha) p.fecha = HOY;
      if(p.ubicacion === undefined){ p.ubicacion = p.zona || ''; delete p.zona; }
      if(p.chofer === undefined) p.chofer = '';
      if(p.ayudante === undefined) p.ayudante = '';
      if(p.motivoCancelacion === undefined) p.motivoCancelacion = '';
      if(p.promotorEmail === undefined) p.promotorEmail = '';
      if(p.telefono === undefined) p.telefono = '';
      if(p.empresaId === undefined) p.empresaId = 'kunturmasha';
      if(p.volumenM3 === undefined) p.volumenM3 = 0;
      if(p.metodoPago === undefined) p.metodoPago = '';
      if(!Array.isArray(p.tiempos) || p.tiempos.length !== ETAPAS.length) p.tiempos = tiemposVacios();
      // Blindaje del ciclo de vida: cualquier pedido con estado ausente, vacío o que
      // no exista en FLUJO_ESTADOS/ESTADOS_FALLIDOS (dato corrupto, import manual de
      // backup, fila editada a mano en Supabase, versión antigua del esquema) vuelve
      // a 'Programado' en vez de dejar un estado "fantasma". Sin esto, statusClass en
      // renderLista() revienta con p.estado.replace(...) y toda la Agenda se queda en
      // blanco para el día afectado.
      if(!p.estado || ESTADOS_VALIDOS.indexOf(p.estado) === -1) p.estado = 'Programado';
    });
    var porFecha = {};
    datos.forEach(function(p){ (porFecha[p.fecha] = porFecha[p.fecha] || []).push(p); });
    Object.keys(porFecha).forEach(function(fecha){
      var grupo = porFecha[fecha];
      var conOrden = grupo.filter(function(p){ return typeof p.orden === 'number'; });
      var sinOrden = grupo.filter(function(p){ return typeof p.orden !== 'number'; });
      var siguiente = conOrden.length ? Math.max.apply(null, conOrden.map(function(p){ return p.orden; })) + 1 : 1;
      sinOrden.sort(function(a,b){ return (a.horaInicio||'').localeCompare(b.horaInicio||''); });
      sinOrden.forEach(function(p){ p.orden = siguiente++; });
    });
    // Código de cliente: reutiliza el existente para el mismo nombre (normalizado) o asigna uno nuevo,
    // en orden de aparición, a partir del máximo número de código ya usado.
    var maxNum = 0;
    var registro = {};
    datos.forEach(function(p){
      if(p.codigoCliente){
        var m = /^CLI-(\d+)$/.exec(p.codigoCliente);
        if(m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
        var norm = normalizarCliente(p.cliente);
        if(norm && !registro[norm]) registro[norm] = p.codigoCliente;
      }
    });
    datos.forEach(function(p){
      if(p.codigoCliente) return;
      var norm = normalizarCliente(p.cliente);
      if(!norm) return;
      if(registro[norm]){ p.codigoCliente = registro[norm]; return; }
      maxNum++;
      var codigo = 'CLI-' + String(maxNum).padStart(3, '0');
      registro[norm] = codigo;
      p.codigoCliente = codigo;
    });
    return datos;
  }

  function cargarPedidos(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(raw){
        return migrarPedidos(JSON.parse(raw));
      }
    }catch(e){ /* sin localStorage o dato corrupto: usamos los iniciales */ }
    return migrarPedidos(PEDIDOS_INICIALES.slice());
  }
  /* ==========================================================================
     Sello de tiempo por fila (updatedAt) para resolver conflictos en la
     sincronización (ver fusionarPorId). Se re-sella SOLO la fila que cambió
     respecto a la última vez que se guardó — así el `updatedAt` refleja de
     verdad "cuándo se tocó por última vez", y en un merge gana la más reciente
     en vez de "la remota siempre". stringifyEstable ignora el orden de claves y
     el propio updatedAt para comparar contenido.
     ========================================================================== */
  var _firmasPedidos = {};
  function firmaContenido(o){
    var c = {};
    Object.keys(o).forEach(function(k){ if(k !== 'updatedAt' && k !== '__clave' && k !== '__fxNum') c[k] = o[k]; });
    return stringifyEstable(c);
  }
  function sellarCambios(lista, firmas){
    var ahora = new Date().toISOString();
    lista.forEach(function(x){
      var f = firmaContenido(x);
      if(!x.updatedAt || firmas[x.id] !== f){ x.updatedAt = ahora; }
      firmas[x.id] = f;
    });
    // olvida firmas de filas borradas
    Object.keys(firmas).forEach(function(id){ if(!lista.some(function(x){ return x.id === id; })) delete firmas[id]; });
  }

  function guardarPedidos(){
    if(!supaAplicandoRemoto) sellarCambios(pedidos, _firmasPedidos);
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(pedidos)); }
    catch(e){ /* sigue funcionando solo en memoria si falla el guardado */ }
    // Si Supabase está conectado, empuja el estado actual de pedidos al servidor.
    // Si no hay conexión (o nunca se configuró), esta línea no hace nada y todo
    // sigue funcionando solo con localStorage, como antes.
    if(supaListo && !supaAplicandoRemoto) reconciliarRemoto('pedidos', pedidos, pedidoARemoto);
  }
  function siguienteId(){
    var maxNum = 0;
    pedidos.forEach(function(p){
      var m = /^PED-(\d+)$/.exec(p.id);
      if(m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    return 'PED-' + String(maxNum + 1).padStart(2, '0');
  }
  function siguienteOrden(fecha){
    var deDia = pedidos.filter(function(p){ return p.fecha === fecha; });
    if(!deDia.length) return 1;
    return Math.max.apply(null, deDia.map(function(p){ return p.orden || 0; })) + 1;
  }

  var pedidos = cargarPedidos();
  guardarPedidos(); // asegura que la migración (ubicacion/orden) quede escrita de inmediato
  var fechaSeleccionada = HOY;
  var filtroEstado = 'Todos';
  var busqueda = '';
  var editandoId = null;

  var els = {
    fechaSelector: document.getElementById('fechaSelector'),
    weekStrip: document.getElementById('weekStrip'),
    statsStrip: document.getElementById('statsStrip'),
    timelineList: document.getElementById('timelineList'),
    form: document.getElementById('orderForm'),
    formTitle: document.getElementById('formTitle'),
    editFlag: document.getElementById('editFlag'),
    btnSubmit: document.getElementById('btnSubmit'),
    btnCancelEdit: document.getElementById('btnCancelEdit'),
    tipoAlmacen: document.getElementById('tipoAlmacen'),
    groupPiso: document.getElementById('groupPiso'),
    chipsDistrito: document.getElementById('chipsDistrito'),
    chipsSector: document.getElementById('chipsSector'),
    detalleUbicacion: document.getElementById('detalleUbicacion'),
    ubicacionError: document.getElementById('ubicacionError'),
    horaInicio: document.getElementById('horaInicio'),
    horaFin: document.getElementById('horaFin'),
    horarioError: document.getElementById('horarioError'),
    precio: document.getElementById('precio'),
    telefono: document.getElementById('telefono'),
    chofer: document.getElementById('chofer'),
    ayudante: document.getElementById('ayudante'),
    conseguidoPor: document.getElementById('conseguidoPor'),
    buscador: document.getElementById('buscador'),
    filterGroup: document.getElementById('filterGroup')
  };

  // "Chofer" se llena según la flota de la empresa activa: cualquier empresa con choferes
  // reales dados de alta (CREDENCIALES_PERSONAL, filtrado por empresaId) usa esa lista para
  // que calce con el cálculo de comisiones; si todavía no tiene ninguno, cae al roster de
  // ejemplo (EMPRESAS[].choferesDemo) — se repuebla cada vez que cambia la empresa activa,
  // ver cambiarEmpresaActiva().
  function choferesDeEmpresaActiva(){
    var empresa = buscarEmpresa(empresaActivaId);
    var reales = rosterDeEmpresa(empresa.id).filter(function(m){ return m.roles.indexOf('chofer') !== -1; }).map(function(m){ return m.nombre; });
    return reales.length ? reales : empresa.choferesDemo;
  }
  function poblarSelectChofer(){
    // Solo choferes CONFIRMADOS en la plantilla de la empresa activa (ver plantillaEmpresas).
    // Si aún no hay ninguno, cae al respaldo de ejemplo (choferesDemo, hoy vacío salvo las
    // empresas mínimas) para no dejar el Despacho sin ninguna opción de arranque.
    var nombres = choferesDeEmpresaActiva();
    els.chofer.innerHTML = '<option value="">— Sin asignar —</option>' +
      nombres.map(function(n){ return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join('');
  }
  poblarSelectChofer();

  /* ==========================================================================
     Algoritmo de despacho "CAJA NEGRA" (roadmap). Regla: ningún chofer atiende al
     MISMO cliente más de 3 veces SEGUIDAS. Al elegir cliente en el Despacho:
       - se mira su historial de choferes (pedidos no cancelados, del más viejo al
         más nuevo);
       - si los últimos 3 son el mismo chofer, ese chofer queda VETADO para el
         siguiente servicio de ese cliente;
       - se sugiere automáticamente otro chofer de la flota — el que hace más
         tiempo que no atiende a ese cliente (o uno que nunca lo hizo).
     Es una regla asistida: el Administrador puede marcar "Forzar" para saltársela
     en un caso puntual (queda como decisión consciente, no accidental).
     ========================================================================== */
  var CAJA_NEGRA_MAX_SEGUIDAS = 3;
  function historialChoferDeCliente(codigoCliente){
    if(!codigoCliente) return [];
    return pedidos
      .filter(function(p){
        return p.codigoCliente === codigoCliente && p.chofer &&
               p.estado !== 'Cancelado' && p.estado !== 'Retiro Voluntario';
      })
      .sort(function(a, b){
        return (a.fecha + String(a.orden || 0).padStart(6, '0'))
             .localeCompare(b.fecha + String(b.orden || 0).padStart(6, '0'));
      })
      .map(function(p){ return p.chofer; });
  }
  function choferVetadoCajaNegra(codigoCliente){
    var h = historialChoferDeCliente(codigoCliente);
    if(h.length < CAJA_NEGRA_MAX_SEGUIDAS) return null;
    var ultimos = h.slice(-CAJA_NEGRA_MAX_SEGUIDAS);
    return ultimos.every(function(n){ return n === ultimos[0]; }) ? ultimos[0] : null;
  }
  // Sugiere un chofer válido: de la flota de la empresa activa, distinto del vetado,
  // priorizando al que hace más tiempo (o nunca) atendió a ese cliente.
  function sugerirChoferCajaNegra(codigoCliente, vetado){
    var flota = choferesDeEmpresaActiva().filter(function(n){ return n && n !== vetado; });
    if(!flota.length) return '';
    var h = historialChoferDeCliente(codigoCliente);
    function ultimaPosicion(nombre){
      var idx = h.lastIndexOf(nombre);
      return idx === -1 ? -1 : idx; // -1 = nunca -> máxima prioridad
    }
    return flota.slice().sort(function(a, b){ return ultimaPosicion(a) - ultimaPosicion(b); })[0];
  }
  // Evalúa el chofer actualmente elegido contra la regla y actualiza el aviso / el
  // checkbox de forzar. Si `autoAsignar` y el elegido está vetado, cambia el <select>
  // al sugerido. Devuelve true si hay un veto activo sin resolver.
  function evaluarCajaNegra(autoAsignar){
    var aviso = document.getElementById('cajaNegraAviso');
    var forzarWrap = document.getElementById('cajaNegraForzarWrap');
    var forzar = document.getElementById('cajaNegraForzar');
    if(!aviso) return false;
    var codigo = obtenerCodigoParaCliente(document.getElementById('cliente').value);
    var vetado = codigo ? choferVetadoCajaNegra(codigo) : null;
    if(!vetado){
      aviso.hidden = true; forzarWrap.style.display = 'none'; forzar.checked = false;
      return false;
    }
    var sugerido = sugerirChoferCajaNegra(codigo, vetado);
    if(autoAsignar && els.chofer.value === vetado && sugerido){
      els.chofer.value = sugerido;
      if(window.fxToast) window.fxToast('Caja Negra: ' + vetado + ' ya atendió a este cliente 3 veces seguidas — se asignó a ' + sugerido, 'ok', 4200);
    }
    var choqueAhora = els.chofer.value === vetado;
    aviso.hidden = false;
    forzarWrap.style.display = choqueAhora ? 'flex' : 'none';
    aviso.textContent = choqueAhora
      ? '⚠️ Caja Negra: ' + vetado + ' ya atendió a este cliente ' + CAJA_NEGRA_MAX_SEGUIDAS + ' veces seguidas. Rotación sugerida: ' + (sugerido || 'sin más choferes disponibles') + '.'
      : '🔄 Caja Negra: rotación aplicada (antes le tocaba a ' + vetado + ').';
    return choqueAhora && !forzar.checked;
  }
  (function initCajaNegra(){
    var elCliente = document.getElementById('cliente');
    if(!elCliente || !els.chofer) return;
    var reeval = debounce(function(){ evaluarCajaNegra(true); }, 250);
    elCliente.addEventListener('input', reeval);
    elCliente.addEventListener('change', reeval);
    els.chofer.addEventListener('change', function(){ evaluarCajaNegra(false); });
    var forzar = document.getElementById('cajaNegraForzar');
    if(forzar) forzar.addEventListener('change', function(){ evaluarCajaNegra(false); });
  })();
  // "Conseguido por / Promotor" se llena desde las PERSONAS con personal confirmado en la
  // empresa activa (no texto libre) para que sus valores calcen siempre con el cálculo de
  // comisiones. Cualquier rol puede traer un cliente (Administradores y Choferes incluidos),
  // pero solo si su empresa ya lo confirmó en la plantilla. Se repuebla al cambiar de empresa.
  function poblarSelectPromotor(){
    var previo = els.conseguidoPor.value;
    els.conseguidoPor.innerHTML = '<option value="">— Cliente directo (sin promotor) —</option>' +
      personasDeEmpresa(empresaActivaId).map(function(pe){ return '<option value="' + escapeHtml(pe.id) + '">' + escapeHtml(nombrePersonaMostrado(pe)) + '</option>'; }).join('');
    els.conseguidoPor.value = previo;
  }
  poblarSelectPromotor();

  var empresaSelectorEl = document.getElementById('empresaSelector');
  // Cambiar de empresa activa reordena qué ve el Administrador: su propia Agenda,
  // Contabilidad, flota de choferes (poblarSelectChofer) y la Sala de Subasta del Hub
  // Central si está abierta — todo deriva de empresaActivaId, no se duplica código de vista.
  function cambiarEmpresaActiva(id){
    if(!EMPRESAS.some(function(e){ return e.id === id; })) return;
    empresaActivaId = id;
    try{ localStorage.setItem(EMPRESA_ACTIVA_KEY, id); }catch(e){}
    // Corrige un desajuste real: la búsqueda/filtro de estado de "Ver agenda" quedaban con el
    // texto/estado de la empresa anterior, y al entrar a la nueva empresa la lista podía verse
    // vacía o filtrada "a medias" sin que se notara por qué. Se resetean a los valores por
    // defecto cada vez que se cambia de empresa activa.
    busqueda = '';
    if(els.buscador) els.buscador.value = '';
    filtroEstado = 'Todos';
    if(els.filterGroup){
      els.filterGroup.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.estado === 'Todos'); });
    }
    poblarSelectChofer();
    poblarSelectPromotor();
    aplicarTinteSegunContexto(true);
    actualizarUIPagosSegunEmpresa();
    renderTodo();
    if(vistaActual === 'contabilidad') renderContabilidad();
    if(vistaActual === 'ayudante') renderAyudante();
    if(vistaActual === 'ajustes') renderAjustes();
  }
  // Aislamiento estricto entre empresas asociadas: una cuenta de Administrador cuya
  // credencial trae empresaId fijo solo puede ver/operar SU empresa — el <select> queda con
  // una única opción y deshabilitado, así nunca puede apuntar empresaActivaId (y por lo tanto
  // los filtros de pedidos/gastos/choferes/Hub Central) a los datos de otra empresa. Solo las
  // cuentas con accesoGlobal (equipo WaterCore Space) ven y pueden elegir entre las 6 opciones
  // (la Sede Central y las 5 empresas asociadas). Se llama al iniciar la app y cada vez que
  // cambia la sesión de personal (entrarComoPersonal/cerrarSesionPersonal).
  function actualizarSelectorEmpresa(){
    var cred = usuarioActual ? buscarCredencial(usuarioActual.email) : null;
    var restringidaA = (cred && cred.empresaId && !cred.accesoGlobal) ? cred.empresaId : null;
    var lista = restringidaA ? EMPRESAS.filter(function(e){ return e.id === restringidaA; }) : EMPRESAS;
    empresaSelectorEl.innerHTML = lista.map(function(e){ return '<option value="' + escapeHtml(e.id) + '">' + escapeHtml(e.nombre) + '</option>'; }).join('');
    empresaSelectorEl.disabled = !!restringidaA;
    if(restringidaA && empresaActivaId !== restringidaA) cambiarEmpresaActiva(restringidaA);
    else empresaSelectorEl.value = empresaActivaId;
  }
  actualizarSelectorEmpresa();
  empresaSelectorEl.addEventListener('change', function(){ cambiarEmpresaActiva(this.value); });

  // Vista previa en vivo de la hora en formato 12h AM/PM junto a cada <input type="time">,
  // para que quede clarísimo qué hora se está eligiendo (el input nativo ya admite el
  // rango completo 00:00–23:59 sin bloquearse en AM; esto solo lo hace inequívoco a simple vista).
  function actualizarPreviewHora(id){
    var input = document.getElementById(id);
    var preview = document.getElementById(id + 'Preview');
    if(!input || !preview) return;
    preview.textContent = input.value ? '→ ' + formatearHora12(input.value) : '';
  }
  ['horaInicio', 'horaFin'].forEach(function(id){
    var input = document.getElementById(id);
    input.addEventListener('input', function(){ actualizarPreviewHora(id); });
  });

  // El chofer ya no es texto libre (ver <select id="chofer">, lista fija de 3), así que
  // aquí solo se refrescan los datalist que siguen siendo texto libre: ayudante y cliente.
  function actualizarListasPersonal(){
    var ayudantes = Array.from(new Set(pedidos.map(function(p){ return p.ayudante; }).filter(Boolean)));
    var clientes = Array.from(new Set(pedidos.map(function(p){ return p.cliente; }).filter(Boolean)));
    document.getElementById('listaAyudantes').innerHTML = ayudantes.map(function(n){ return '<option value="' + escapeHtml(n) + '">'; }).join('');
    document.getElementById('listaClientes').innerHTML = clientes.map(function(n){ return '<option value="' + escapeHtml(n) + '">'; }).join('');
  }

  // Muestra en vivo el código de cliente (existente o el que se asignaría) mientras se escribe el nombre.
  document.getElementById('cliente').addEventListener('input', function(){
    var nota = document.getElementById('clienteCodigoNota');
    var norm = normalizarCliente(this.value);
    if(!norm){ nota.hidden = true; return; }
    var st = estadisticasClientes()[obtenerCodigoParaCliente(this.value)];
    var existe = pedidos.some(function(p){ return p.codigoCliente && normalizarCliente(p.cliente) === norm; });
    var codigo = obtenerCodigoParaCliente(this.value);
    nota.hidden = false;
    nota.textContent = existe ?
      'Cliente existente — código ' + codigo + (st && st.completados ? ' · ' + st.completados + ' viaje' + (st.completados > 1 ? 's' : '') + ' completado' + (st.completados > 1 ? 's' : '') : '') :
      'Cliente nuevo — se le asignará el código ' + codigo + '.';
  });

  /* ---------- Ubicación: distrito → zona conocida de ese distrito → detalle libre ---------- */
  // Los 12 distritos oficiales de la provincia de Trujillo (La Libertad, Perú), con una lista
  // de zonas/sectores conocidos por distrito. La lista de zonas es una guía útil, no exhaustiva:
  // cuando un distrito no tiene una zona conocida en la lista, o la zona real no aparece,
  // el campo de detalle libre siempre queda disponible para escribirla.
  var ZONAS_POR_DISTRITO = {
    'Trujillo (Cercado)': ['Centro Histórico', 'Urb. La Merced', 'Urb. Palermo', 'La Rinconada'],
    'El Porvenir': ['Vista Alegre', 'Río Seco', 'Bello Horizonte'],
    'La Esperanza': ['Manuel Arévalo', 'Wichanzao'],
    'Florencia de Mora': [],
    'Huanchaco': ['El Milagro', 'Huanchaco Balneario', 'Las Lomas'],
    'Víctor Larco': ['Buenos Aires', 'California', 'Urb. El Golf'],
    'Moche': ['Moche Pueblo', 'Las Delicias'],
    'Salaverry': ['Salaverry Puerto'],
    'Laredo': ['Laredo Centro', 'Cortijo'],
    'Poroto': [],
    'Simbal': [],
    'Alto Trujillo': ['Sector I', 'Sector II', 'Sector III'],
    'El Milagro': [],
    'Luz del Sol': []
  };
  var DISTRITOS = Object.keys(ZONAS_POR_DISTRITO);
  var TODAS_LAS_ZONAS = Object.keys(ZONAS_POR_DISTRITO).reduce(function(acc, d){
    ZONAS_POR_DISTRITO[d].forEach(function(z){ acc.push({ zona: z, distrito: d }); });
    return acc;
  }, []);
  var distritoSel = '';
  var zonaSel = '';

  function renderChipsUbicacion(){
    els.chipsDistrito.innerHTML = DISTRITOS.map(function(d){
      return '<button type="button" class="chip' + (d === distritoSel ? ' selected' : '') + '" data-distrito="' + escapeHtml(d) + '">' + d + '</button>';
    }).join('');
    var zonas = distritoSel ? ZONAS_POR_DISTRITO[distritoSel] : [];
    if(!distritoSel){
      els.chipsSector.innerHTML = '<span class="chip-hint">Elige primero un distrito</span>';
    } else if(zonas.length === 0){
      els.chipsSector.innerHTML = '<span class="chip-hint">Sin zonas conocidas para ' + escapeHtml(distritoSel) + ' — usa el detalle exacto</span>';
    } else {
      els.chipsSector.innerHTML = zonas.map(function(z){
        return '<button type="button" class="chip' + (z === zonaSel ? ' selected' : '') + '" data-zona="' + escapeHtml(z) + '">' + z + '</button>';
      }).join('');
    }
  }
  els.chipsDistrito.addEventListener('click', function(e){
    var chip = e.target.closest('.chip');
    if(!chip) return;
    var d = chip.dataset.distrito;
    if(distritoSel !== d){ distritoSel = d; zonaSel = ''; }
    else { distritoSel = ''; zonaSel = ''; }
    els.ubicacionError.hidden = true;
    renderChipsUbicacion();
  });
  els.chipsSector.addEventListener('click', function(e){
    var chip = e.target.closest('.chip');
    if(!chip) return;
    var z = chip.dataset.zona;
    if(z === undefined) return;
    zonaSel = (zonaSel === z) ? '' : z;
    els.ubicacionError.hidden = true;
    renderChipsUbicacion();
  });

  function armarUbicacion(){
    var partes = [distritoSel, zonaSel, els.detalleUbicacion.value.trim()].filter(Boolean);
    return partes.join(', ');
  }
  // Intenta reconocer distrito/zona dentro de un texto de ubicación guardado previamente,
  // para poder pre-llenar los chips al editar un pedido antiguo.
  function analizarUbicacion(texto){
    var partes = String(texto || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var distrito = '', zona = '', resto = [];
    partes.forEach(function(parte){
      var pd = !distrito && DISTRITOS.filter(function(d){ return d.toLowerCase() === parte.toLowerCase(); })[0];
      var pz = !zona && TODAS_LAS_ZONAS.filter(function(z){ return z.zona.toLowerCase() === parte.toLowerCase(); })[0];
      if(pd) distrito = pd;
      else if(pz){ zona = pz.zona; if(!distrito) distrito = pz.distrito; }
      else resto.push(parte);
    });
    return { distrito: distrito, zona: zona, detalle: resto.join(', ') };
  }
  function fijarChipsUbicacion(texto){
    var r = analizarUbicacion(texto);
    distritoSel = r.distrito;
    zonaSel = r.zona;
    els.detalleUbicacion.value = r.detalle;
    renderChipsUbicacion();
  }
  function limpiarChipsUbicacion(){
    distritoSel = '';
    zonaSel = '';
    els.detalleUbicacion.value = '';
    els.ubicacionError.hidden = true;
    renderChipsUbicacion();
  }
  renderChipsUbicacion();

  /* ---------- Día seleccionado ---------- */
  function seleccionarFecha(iso){
    fechaSeleccionada = iso;
    els.fechaSelector.value = iso;
    if(!editandoId) document.getElementById('fecha').value = iso;
    renderTodo();
  }
  els.fechaSelector.value = fechaSeleccionada;
  els.fechaSelector.addEventListener('change', function(){
    if(this.value) seleccionarFecha(this.value);
  });
  document.getElementById('btnPrevDay').addEventListener('click', function(){
    seleccionarFecha(sumarDias(fechaSeleccionada, -1));
  });
  document.getElementById('btnNextDay').addEventListener('click', function(){
    seleccionarFecha(sumarDias(fechaSeleccionada, 1));
  });
  document.getElementById('btnHoy').addEventListener('click', function(){
    seleccionarFecha(HOY);
  });

  // Igual que statTileCache/tarjetaHtmlCache más abajo: guarda el HTML generado de cada
  // chip la última vez, para solo tocar el DOM del que realmente cambió (en vez de
  // vaciar y reconstruir las 7 casillas en cada sincronización de Supabase).
  var weekChipCache = [];
  function renderWeekStrip(){
    var centro = new Date(fechaSeleccionada + 'T00:00:00');
    var dias = [];
    for(var i = -3; i <= 3; i++){
      var d = new Date(centro);
      d.setDate(d.getDate() + i);
      dias.push(d);
    }
    var htmls = dias.map(function(d){
      var iso = isoDe(d);
      var count = pedidos.filter(function(p){ return p.fecha === iso; }).length;
      var clase = 'day-chip' + (iso === fechaSeleccionada ? ' selected' : '') + (iso === HOY ? ' today' : '');
      return '<div class="' + clase + '" data-iso="' + iso + '">' +
        '<div class="dow">' + d.toLocaleDateString('es-PE',{weekday:'short'}) + '</div>' +
        '<div class="num">' + String(d.getDate()).padStart(2,'0') + '</div>' +
        '<div class="cnt">' + (count ? count + ' pedido' + (count>1?'s':'') : '—') + '</div>' +
        '</div>';
    });
    if(els.weekStrip.children.length !== htmls.length){
      els.weekStrip.innerHTML = htmls.join('');
      weekChipCache = htmls.slice();
    } else {
      htmls.forEach(function(html, i){
        if(weekChipCache[i] !== html){
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          els.weekStrip.children[i].replaceWith(tmp.firstElementChild);
          weekChipCache[i] = html;
        }
      });
    }
    // El listener de clic se delega una sola vez en el contenedor (justo abajo) en vez de
    // reatarse a cada chip nuevo, así que reemplazar un chip no pierde su comportamiento.
  }
  els.weekStrip.addEventListener('click', function(e){
    var chip = e.target.closest('.day-chip');
    if(chip) seleccionarFecha(chip.dataset.iso);
  });

  /* ---------- Estadísticas del día ---------- */
  var statTileCache = [];
  function renderStats(){
    var delDia = pedidos.filter(function(p){ return p.fecha === fechaSeleccionada && (p.empresaId || 'kunturmasha') === empresaActivaId; });
    var abiertos = delDia.filter(esAbierto);
    var completados = delDia.filter(function(p){ return p.estado === 'Completado'; });
    var fallidos = delDia.filter(esFallido).length;
    var ingresoCobrado = completados.reduce(function(s,p){ return s + Number(p.precio||0); }, 0);
    var ingresoProgramado = abiertos.reduce(function(s,p){ return s + Number(p.precio||0); }, 0);

    // Las cifras de negocio (cobrado / por cobrar) son "reportes financieros" — el rol
    // "cliente" no debe verlas; el rol "chofer" ve su propio pago en vez del ingreso total
    // de la empresa. Solo "admin" (y de forma implícita "promotor", que no usa esta vista)
    // ve el desglose completo.
    var tiles;
    if(rolActivo === 'cliente'){
      tiles = [
        { label: 'Pedidos del día', value: delDia.length },
        { label: 'En curso (agenda)', value: abiertos.length },
        { label: 'Completados', value: completados.length, cls:'good' },
        { label: 'Cancelados / retirados', value: fallidos, cls: fallidos ? 'bad' : '' }
      ];
    } else if(rolActivo === 'chofer'){
      var pagoChofer = completados.reduce(function(s,p){ return s + manoDeObra(p.precio, p.empresaId).chofer; }, 0);
      // "fijo_dia": se paga una sola vez por día trabajado, no por viaje (ver manoDeObra(),
      // que ya devuelve 0 por viaje en esa modalidad) — se suma aparte si hubo al menos un
      // viaje completado hoy para la empresa activa.
      if(completados.length && configPagosDe(empresaActivaId).choferModalidad === 'fijo_dia'){
        pagoChofer += Number(configPagosDe(empresaActivaId).choferMonto) || 0;
      }
      tiles = [
        { label: 'Pedidos del día', value: delDia.length },
        { label: 'En curso (agenda)', value: abiertos.length },
        { label: 'Mis pagos (chofer) hoy', value: 'S/. ' + pagoChofer.toFixed(2), cls:'good' },
        { label: 'Cancelados / retirados', value: fallidos, cls: fallidos ? 'bad' : '' }
      ];
    } else {
      tiles = [
        { label: 'Pedidos del día', value: delDia.length },
        { label: 'En curso (agenda)', value: abiertos.length },
        { label: 'Cobrado (completados)', value: 'S/. ' + ingresoCobrado.toFixed(2), cls:'good' },
        { label: 'Por cobrar (en agenda)', value: 'S/. ' + ingresoProgramado.toFixed(2), cls:'accent' },
        { label: 'Cancelados / retirados', value: fallidos, cls: fallidos ? 'bad' : '' }
      ];
    }
    var htmls = tiles.map(tileHtml);
    // Los tiles son siempre 5, en el mismo orden: si cambia la cantidad (no debería) se
    // reconstruye todo; si no, se actualiza en el DOM solo el tile cuyo valor cambió, en
    // vez de repintar los 5 en cada actualización (evita repetir su animación de entrada
    // — y el parpadeo que eso provoca — cuando en realidad solo cambió una cifra).
    if(els.statsStrip.children.length !== htmls.length){
      els.statsStrip.innerHTML = htmls.join('');
      statTileCache = htmls.slice();
      return;
    }
    htmls.forEach(function(html, i){
      if(statTileCache[i] !== html){
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        els.statsStrip.children[i].replaceWith(tmp.firstElementChild);
        statTileCache[i] = html;
      }
    });
  }
  function tileHtml(t){
    return '<div class="stat-tile ' + (t.cls||'') + '"><div class="label">' + t.label + '</div><div class="value mono">' + t.value + '</div></div>';
  }

  /* ---------- Form: piso condicional y precio sugerido ---------- */
  function togglePiso(){
    els.groupPiso.style.display = els.tipoAlmacen.value === 'Tanque Elevado' ? 'block' : 'none';
  }
  els.tipoAlmacen.addEventListener('change', togglePiso);

  /* ---------- Filtros de agenda ---------- */
  els.filterGroup.addEventListener('click', function(e){
    var btn = e.target.closest('.filter-btn');
    if(!btn) return;
    els.filterGroup.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    filtroEstado = btn.dataset.estado;
    renderLista();
  });
  var renderListaDebounced = debounce(renderLista, 220);
  els.buscador.addEventListener('input', function(){
    busqueda = this.value.trim().toLowerCase();
    renderListaDebounced();
  });

  /* ---------- Lista de pedidos ---------- */
  // FLUJO_ESTADOS / ESTADOS_FALLIDOS / ESTADOS_ABIERTOS / ESTADOS_VALIDOS están
  // definidos más arriba, junto a ETAPAS, para que migrarPedidos() pueda usarlos.
  function esFallido(p){ return ESTADOS_FALLIDOS.indexOf(p.estado) !== -1; }
  function esAbierto(p){ return ESTADOS_ABIERTOS.indexOf(p.estado) !== -1; }

  // Busca, entre los pedidos del mismo día (sin contar cancelados/retirados ni el propio
  // pedido que se está editando/postergando), uno cuyo rango horario se cruce con
  // [horaInicio, horaFin]. Se exige al menos 1 minuto de separación entre viajes: un pedido
  // que termina a las 02:00 PM deja libre recién las 02:01 PM en adelante.
  function encontrarConflictoHorario(fecha, horaInicio, horaFin, excluirId){
    var nInicio = minutosDesdeMedianoche(horaInicio);
    var nFin = minutosDesdeMedianoche(horaFin);
    if(nInicio === null || nFin === null) return null;
    var candidatos = pedidos.filter(function(p){
      return p.fecha === fecha && p.id !== excluirId && !esFallido(p);
    });
    for(var i = 0; i < candidatos.length; i++){
      var p = candidatos[i];
      var pInicio = minutosDesdeMedianoche(p.horaInicio);
      var pFin = minutosDesdeMedianoche(p.horaFin);
      if(pInicio === null || pFin === null) continue;
      if(nInicio <= pFin && nFin >= pInicio) return p;
    }
    return null;
  }

  // Orden de la agenda: primero todos los pedidos activos (todo lo anterior a Completado
  // y no cancelado/retirado), del más próximo al más lejano por hora de inicio; al final,
  // los cerrados (Completado, Cancelado, Retirado). Dentro de un mismo grupo/hora, el campo
  // manual "orden" (ajustable con ⬆ ⬇) desempata. Se centraliza aquí porque tanto la lista
  // (renderLista) como el reordenamiento manual (moverPedido) deben usar exactamente el
  // mismo criterio, o los botones ⬆ ⬇ moverían pedidos a posiciones que no coinciden con
  // lo que se ve en pantalla.
  function ordenarDelDia(fecha){
    // Filtrado por empresaActivaId: cada empresa/pozo asociado ve solo su propia agenda —
    // los pedidos ya existentes (de antes del marketplace multiempresa) son de 'kunturmasha'.
    var deDia = pedidos.filter(function(p){ return p.fecha === fecha && (p.empresaId || 'kunturmasha') === empresaActivaId; });
    deDia.sort(function(a, b){
      var aAbierto = esAbierto(a) ? 0 : 1;
      var bAbierto = esAbierto(b) ? 0 : 1;
      if(aAbierto !== bAbierto) return aAbierto - bAbierto;
      if(aAbierto === 0){
        var aMin = minutosDesdeMedianoche(a.horaInicio); if(aMin === null) aMin = 0;
        var bMin = minutosDesdeMedianoche(b.horaInicio); if(bMin === null) bMin = 0;
        if(aMin !== bMin) return aMin - bMin;
      }
      return (a.orden || 0) - (b.orden || 0);
    });
    return deDia;
  }

  // Texto del botón "Avanzar" según el estado actual: indica la acción que el
  // chofer/operador está a punto de hacer, no el estado al que va a llegar.
  var TEXTO_AVANZAR = {
    'Programado': '▶ Iniciar Llenado',
    'Llenado': '▶ Iniciar Traslado',
    'En Ruta': '▶ Iniciar Descarga',
    'Descarga': '▶ Iniciar Retorno a Base',
    'Regresando a Base': '✔ Finalizar Viaje (Completado)'
  };

  // Estadísticas por cliente (histórico completo, no solo el periodo/día visible) para poder
  // señalar pedidos prioritarios por precio y por concurrencia del servicio.
  function estadisticasClientes(){
    var stats = {};
    pedidos.forEach(function(p){
      if(!p.codigoCliente) return;
      if(!stats[p.codigoCliente]) stats[p.codigoCliente] = { viajes: 0, completados: 0, ingresoTotal: 0 };
      stats[p.codigoCliente].viajes++;
      if(p.estado === 'Completado'){
        stats[p.codigoCliente].completados++;
        stats[p.codigoCliente].ingresoTotal += Number(p.precio) || 0;
      }
    });
    return stats;
  }
  function precioPromedioGlobal(){
    var validos = pedidos.filter(function(p){ return !esFallido(p); });
    if(!validos.length) return 0;
    return validos.reduce(function(s,p){ return s + (Number(p.precio)||0); }, 0) / validos.length;
  }
  function etiquetaPrioridad(p, stats, promedio){
    var st = stats[p.codigoCliente] || { completados: 0 };
    var frecuente = st.completados >= 3;
    var altoValor = promedio > 0 && Number(p.precio) >= promedio * 1.25;
    if(frecuente && altoValor) return { texto: '⭐ Prioridad alta', cls: 'prioridad-alta' };
    if(frecuente) return { texto: '🔁 Cliente frecuente (' + st.completados + ')', cls: 'prioridad-media' };
    if(altoValor) return { texto: '💰 Viaje de alto valor', cls: 'prioridad-media' };
    return null;
  }

  function renderPanelTiempos(p){
    // El rol "cliente" es de solo seguimiento: ve el estado de cada etapa pero no puede
    // marcar inicio/fin (eso es una acción operativa del chofer).
    var soloLectura = rolActivo === 'cliente';
    var tiempos = p.tiempos && p.tiempos.length === ETAPAS.length ? p.tiempos : tiemposVacios();
    var filas = ETAPAS.map(function(nombre, idx){
      var et = tiempos[idx];
      var contenido;
      if(!et.inicio){
        if(soloLectura){
          contenido = '<span class="etapa-marca">Pendiente</span>';
        } else {
          var habilitado = idx === 0 || (tiempos[idx-1] && tiempos[idx-1].fin);
          contenido = '<button type="button" class="btn-mini" data-etapa-idx="' + idx + '" data-etapa-accion="iniciar"' + (habilitado ? '' : ' disabled') + '>▶ Iniciar</button>';
        }
      } else if(!et.fin){
        contenido = '<span class="etapa-marca">Inició ' + formatearHora(et.inicio) + '</span>' +
          (soloLectura ? '' : ' <button type="button" class="btn-mini" data-etapa-idx="' + idx + '" data-etapa-accion="finalizar">⏹ Finalizar</button>');
      } else {
        var dur = new Date(et.fin) - new Date(et.inicio);
        contenido = '<span class="etapa-marca ok">' + formatearHora(et.inicio) + '–' + formatearHora(et.fin) + ' · ' + formatearDuracionMin(dur) + '</span>';
      }
      return '<div class="etapa-row"><span class="etapa-nombre">' + (idx+1) + '. ' + nombre + '</span><span class="etapa-control">' + contenido + '</span></div>';
    }).join('');
    var total = '';
    if(tiempos[0].inicio && tiempos[tiempos.length-1].fin){
      var totalMs = new Date(tiempos[tiempos.length-1].fin) - new Date(tiempos[0].inicio);
      total = '<div class="etapa-total">⏱ Tiempo total del servicio: ' + formatearDuracionMin(totalMs) + '</div>';
    }
    return '<details class="tiempos-panel"' + (panelesTiemposAbiertos[p.id] ? ' open' : '') + '>' +
      '<summary>⏱ Control de tiempos</summary>' +
      '<div class="etapas-lista">' + filas + '</div>' + total +
    '</details>';
  }

  // Arma el HTML de una sola tarjeta de pedido. Separado de renderLista() para poder
  // comparar el resultado contra lo último renderizado y así actualizar en el DOM
  // solo las tarjetas cuyo contenido realmente cambió (ver renderLista).
  function renderTarjeta(p, stats, promedio, sinFiltrar, deDia){
    // Rol "cliente": solo seguimiento — sin reordenar, sin cancelar/retirar/editar/borrar,
    // sin botón "Avanzar" (esas son acciones operativas de chofer/administración).
    var soloLectura = rolActivo === 'cliente';
    var diffClass = p.dificultad === 'Fácil' ? 'diff-facil' : (p.dificultad === 'Media' ? 'diff-media' : 'diff-dificil');
    var statusClass = 'status-' + p.estado.replace(/ /g, '-');
    var posicion = deDia.indexOf(p);
    var fallido = esFallido(p);
    var reorderHtml = (sinFiltrar && !soloLectura) ?
      '<div class="reorder-group">' +
        '<button class="btn-icon" data-action="subir" title="Adelantar en la ruta"' + (posicion === 0 ? ' disabled' : '') + '>⬆</button>' +
        '<button class="btn-icon" data-action="bajar" title="Postergar en la ruta"' + (posicion === deDia.length - 1 ? ' disabled' : '') + '>⬇</button>' +
      '</div>' : '';
    var abierto = esAbierto(p);
    var accionesEstado = soloLectura ? '' : (abierto ?
      '<button class="btn-icon" data-action="postergar" title="Postergar horario">⏰</button>' +
      '<button class="btn-icon danger" data-action="cancelar" title="Cancelar servicio">✕</button>' +
      '<button class="btn-icon" data-action="retirar" title="Retiro voluntario del cliente">↩</button>' :
      '<button class="btn-icon" data-action="reabrir" title="Reabrir pedido (corregir estado)">↺</button>');
    var textoAvanzar = TEXTO_AVANZAR[p.estado];
    var bloqueAvanzar = (!soloLectura && abierto && textoAvanzar) ?
      '<div class="avanzar-bloque">' +
        '<button type="button" class="btn btn-avanzar" data-action="avanzar" title="' + textoAvanzar + '">' + textoAvanzar + '</button>' +
        '<span class="avanzar-ayuda">¿Qué hacer ahora?</span>' +
      '</div>' : '';
    var prioridad = abierto ? etiquetaPrioridad(p, stats, promedio) : null;
    var accionesHtml = soloLectura ? '' :
      '<div class="order-actions">' +
        reorderHtml +
        '<button class="btn-icon" data-action="editar" title="Editar">✎</button>' +
        accionesEstado +
        '<button class="btn-icon danger" data-action="eliminar" title="Eliminar">🗑</button>' +
      '</div>';
    return '' +
      '<div class="order-card ' + diffClass + (fallido ? ' fallido' : '') + (p.estado === 'Regresando a Base' ? ' regresando' : '') + (p.id === editandoId ? ' editing' : '') + '" data-id="' + escapeHtml(p.id) + '">' +
        '<div class="order-head">' +
          '<div class="order-time">🕒 ' + formatearHora12(p.horaInicio) + ' – ' + formatearHora12(p.horaFin) + '</div>' +
          '<div class="order-price">S/. ' + (isFinite(Number(p.precio)) ? Number(p.precio).toFixed(2) : '0.00') + '</div>' +
        '</div>' +
        '<div class="order-client">' + escapeHtml(p.cliente) + (p.codigoCliente ? ' <span class="cliente-codigo">' + escapeHtml(p.codigoCliente) + '</span>' : '') + '</div>' +
        '<div class="order-ubicacion">📍 ' + escapeHtml(p.ubicacion || 'Sin ubicación registrada') + '</div>' +
        (p.telefono ? '<div class="order-ubicacion">📞 ' + escapeHtml(p.telefono) + '</div>' : '') +
        '<div class="order-meta">' +
          '<span class="meta-tag">' + escapeHtml(p.tipoAlmacen) + (p.piso !== '-' ? ' · ' + escapeHtml(p.piso) : '') + '</span>' +
          (p.volumenM3 ? '<span class="meta-tag">💧 ' + escapeHtml(String(p.volumenM3)) + ' m³</span>' : '') +
          '<span class="meta-tag">Dificultad: ' + escapeHtml(p.dificultad) + '</span>' +
          '<span class="meta-tag">Manguera: ' + escapeHtml(p.manguera) + '</span>' +
          (p.metodoPago ? '<span class="meta-tag">' + escapeHtml(p.metodoPago) + '</span>' : '') +
          (p.chofer ? '<span class="meta-tag">🧑‍✈️ ' + escapeHtml(p.chofer) + '</span>' : '') +
          (p.ayudante ? '<span class="meta-tag">🧑‍🔧 ' + escapeHtml(p.ayudante) + '</span>' : '') +
          (prioridad ? '<span class="meta-tag badge-prioridad ' + prioridad.cls + '">' + prioridad.texto + '</span>' : '') +
        '</div>' +
        (p.notas ? '<div class="order-notas">' + escapeHtml(p.notas) + '</div>' : '') +
        (p.motivoCancelacion ? '<div class="order-motivo">Motivo: ' + escapeHtml(p.motivoCancelacion) + '</div>' : '') +
        (!fallido ? renderPanelTiempos(p) : '') +
        bloqueAvanzar +
        '<div class="order-foot">' +
          '<div><span class="status-pill ' + statusClass + '">' + escapeHtml(p.estado) + '</span> <span class="order-id">' + escapeHtml(p.id) + '</span></div>' +
          accionesHtml +
        '</div>' +
      '</div>';
  }

  // Guarda, por id de pedido, el último HTML de tarjeta ya pintado en el DOM.
  var tarjetaHtmlCache = {};

  function renderLista(){
    var container = els.timelineList;
    var deDia = ordenarDelDia(fechaSeleccionada);

    var sinFiltrar = filtroEstado === 'Todos' && !busqueda;
    var lista = deDia;
    if(filtroEstado === 'Fallidos') lista = lista.filter(esFallido);
    else if(filtroEstado !== 'Todos') lista = lista.filter(function(p){ return p.estado === filtroEstado; });
    if(busqueda) lista = lista.filter(function(p){ return p.cliente.toLowerCase().indexOf(busqueda) !== -1; });

    if(lista.length === 0){
      if(!container.querySelector('.empty-state') || container.children.length !== 1){
        container.innerHTML = '<div class="empty-state">No hay pedidos que coincidan para este día.</div>';
      }
      tarjetaHtmlCache = {};
      return;
    }
    if(container.querySelector('.empty-state')) container.innerHTML = '';

    var stats = estadisticasClientes();
    var promedio = precioPromedioGlobal();

    // Reconciliación por id: en vez de innerHTML = '' + repintar TODAS las tarjetas en
    // cada actualización (lo que antes disparaba de nuevo las animaciones de entrada de
    // todo el listado en cada sincronización de Supabase — la causa del parpadeo negro
    // sobre el fondo OLED — y era costoso con muchos pedidos), solo se toca el DOM de
    // las tarjetas cuyo HTML generado cambió respecto a la última vez, se insertan las
    // nuevas y se quitan las que ya no corresponden. Las tarjetas sin cambios ni se
    // recrean ni vuelven a animarse.
    var nodosActuales = {};
    Array.prototype.forEach.call(container.children, function(nodo){ nodosActuales[nodo.dataset.id] = nodo; });

    var vistos = {};
    var anterior = null;
    lista.forEach(function(p){
      vistos[p.id] = true;
      var html = renderTarjeta(p, stats, promedio, sinFiltrar, deDia);
      var nodo = nodosActuales[p.id];
      if(!nodo || tarjetaHtmlCache[p.id] !== html){
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var nuevo = tmp.firstElementChild;
        if(nodo) nodo.replaceWith(nuevo);
        nodo = nuevo;
        tarjetaHtmlCache[p.id] = html;
      }
      var esperado = anterior ? anterior.nextElementSibling : container.firstElementChild;
      if(esperado !== nodo) container.insertBefore(nodo, esperado);
      anterior = nodo;
    });

    Object.keys(nodosActuales).forEach(function(id){
      if(!vistos[id]){
        nodosActuales[id].remove();
        delete tarjetaHtmlCache[id];
      }
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  var panelesTiemposAbiertos = {};
  els.timelineList.addEventListener('toggle', function(e){
    if(e.target && e.target.classList && e.target.classList.contains('tiempos-panel')){
      var card = e.target.closest('.order-card');
      if(card) panelesTiemposAbiertos[card.dataset.id] = e.target.open;
    }
  }, true);

  els.timelineList.addEventListener('click', function(e){
    var etapaBtn = e.target.closest('button[data-etapa-accion]');
    if(etapaBtn){
      if(etapaBtn.disabled) return;
      var cardEtapa = e.target.closest('.order-card');
      marcarTiempo(cardEtapa.dataset.id, parseInt(etapaBtn.dataset.etapaIdx, 10), etapaBtn.dataset.etapaAccion);
      return;
    }
    var btn = e.target.closest('button[data-action]');
    if(!btn || btn.disabled) return;
    var card = e.target.closest('.order-card');
    var id = card.dataset.id;
    if(btn.dataset.action === 'editar') iniciarEdicion(id);
    else if(btn.dataset.action === 'avanzar') avanzarEstado(id);
    else if(btn.dataset.action === 'reabrir') reabrirPedido(id);
    else if(btn.dataset.action === 'cancelar') abrirModalCancelacion(id, 'Cancelado');
    else if(btn.dataset.action === 'retirar') abrirModalCancelacion(id, 'Retirado');
    else if(btn.dataset.action === 'postergar') abrirModalPostergar(id);
    else if(btn.dataset.action === 'eliminar') eliminarPedido(id);
    else if(btn.dataset.action === 'subir') moverPedido(id, -1);
    else if(btn.dataset.action === 'bajar') moverPedido(id, 1);
  });

  function avanzarEstado(id){
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p) return;
    var idx = FLUJO_ESTADOS.indexOf(p.estado);
    if(idx === -1 || idx === FLUJO_ESTADOS.length - 1) return; // estado desconocido o ya completado: no hace nada
    p.estado = FLUJO_ESTADOS[idx + 1];
    guardarPedidos();
    renderTodo();
  }
  function reabrirPedido(id){
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p) return;
    if(!confirm('¿Reabrir este pedido y volver a marcarlo como Programado?')) return;
    p.estado = 'Programado';
    p.motivoCancelacion = '';
    guardarPedidos();
    renderTodo();
  }
  function marcarTiempo(id, idx, accion){
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p || isNaN(idx)) return;
    if(!Array.isArray(p.tiempos) || p.tiempos.length !== ETAPAS.length) p.tiempos = tiemposVacios();
    var et = p.tiempos[idx];
    if(!et) return;
    var ahora = new Date().toISOString();
    if(accion === 'iniciar' && !et.inicio) et.inicio = ahora;
    else if(accion === 'finalizar' && et.inicio && !et.fin) et.fin = ahora;
    guardarPedidos();
    renderLista();
  }
  function eliminarPedido(id){
    if(!confirm('¿Eliminar este pedido? Esta acción no se puede deshacer.')) return;
    pedidos = pedidos.filter(function(x){ return x.id !== id; });
    if(editandoId === id) cancelarEdicion();
    guardarPedidos();
    renderTodo();
  }
  function moverPedido(id, delta){
    var deDia = ordenarDelDia(fechaSeleccionada);
    var idx = deDia.findIndex(function(p){ return p.id === id; });
    var j = idx + delta;
    if(idx < 0 || j < 0 || j >= deDia.length) return;
    var tmp = deDia[idx].orden;
    deDia[idx].orden = deDia[j].orden;
    deDia[j].orden = tmp;
    guardarPedidos();
    renderLista();
  }

  /* ---------- Alta / edición ---------- */
  function iniciarEdicion(id){
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p) return;
    editandoId = id;
    document.getElementById('fecha').value = p.fecha;
    document.getElementById('horaInicio').value = p.horaInicio;
    document.getElementById('horaFin').value = p.horaFin;
    actualizarPreviewHora('horaInicio');
    actualizarPreviewHora('horaFin');
    document.getElementById('cliente').value = p.cliente;
    document.getElementById('cliente').dispatchEvent(new Event('input'));
    fijarChipsUbicacion(p.ubicacion || '');
    els.telefono.value = p.telefono || '';
    els.precio.value = p.precio;
    els.chofer.value = p.chofer || '';
    els.ayudante.value = p.ayudante || '';
    els.conseguidoPor.value = resolverPersonaId(p.promotorEmail);
    document.getElementById('volumenM3').value = p.volumenM3 || '';
    document.getElementById('metodoPago').value = p.metodoPago || 'Efectivo';
    els.tipoAlmacen.value = p.tipoAlmacen;
    document.getElementById('piso').value = (p.piso && p.piso !== '-') ? p.piso : '1er piso';
    document.getElementById('dificultad').value = p.dificultad;
    document.getElementById('manguera').value = p.manguera;
    document.getElementById('notas').value = p.notas || '';
    togglePiso();

    els.formTitle.textContent = 'Editando pedido';
    els.editFlag.hidden = false;
    els.editFlag.textContent = id;
    els.btnSubmit.textContent = 'Guardar cambios';
    els.btnCancelEdit.hidden = false;
    irAVista('agendar');
  }
  function cancelarEdicion(){
    editandoId = null;
    els.form.reset();
    document.getElementById('fecha').value = fechaSeleccionada;
    document.getElementById('clienteCodigoNota').hidden = true;
    limpiarChipsUbicacion();
    togglePiso();
    // Autocompleta "Conseguido por" con la propia cuenta si quien registra es un promotor
    // con sesión iniciada — visible desde ya en el formulario, no solo al guardar (ver
    // también el mismo fallback en el submit, por si esto no llegó a correr).
    if(rolActivo === 'promotor' && usuarioActual){
      var personaPropia = personaDeCredencial(buscarCredencial(usuarioActual.email));
      if(personaPropia) els.conseguidoPor.value = personaPropia.id;
    }
    els.formTitle.textContent = 'Registrar nuevo despacho';
    els.editFlag.hidden = true;
    els.btnSubmit.textContent = '+ Programar en agenda';
    els.btnCancelEdit.hidden = true;
    els.horarioError.hidden = true;
    var avisoCN = document.getElementById('cajaNegraAviso');
    if(avisoCN){
      avisoCN.hidden = true;
      document.getElementById('cajaNegraForzarWrap').style.display = 'none';
      document.getElementById('cajaNegraForzar').checked = false;
    }
    actualizarPreviewHora('horaInicio');
    actualizarPreviewHora('horaFin');
    renderLista();
  }
  els.btnCancelEdit.addEventListener('click', function(){
    cancelarEdicion();
    irAVista(VISTAS_POR_ROL[rolActivo].tabs.indexOf('agenda') !== -1 ? 'agenda' : VISTAS_POR_ROL[rolActivo].defaultView);
  });

  els.form.addEventListener('submit', function(e){
    e.preventDefault();
    els.horarioError.hidden = true;
    if(!distritoSel && !zonaSel){
      els.ubicacionError.hidden = false;
      els.chipsDistrito.scrollIntoView({ behavior:'smooth', block:'center' });
      return;
    }
    var tipo = els.tipoAlmacen.value;
    var nombreCliente = document.getElementById('cliente').value;
    var datos = {
      fecha: document.getElementById('fecha').value || fechaSeleccionada,
      cliente: nombreCliente,
      codigoCliente: obtenerCodigoParaCliente(nombreCliente),
      telefono: els.telefono.value.trim(),
      ubicacion: armarUbicacion(),
      horaInicio: document.getElementById('horaInicio').value,
      horaFin: document.getElementById('horaFin').value,
      precio: parseFloat(els.precio.value),
      volumenM3: parseFloat(document.getElementById('volumenM3').value) || 0,
      metodoPago: document.getElementById('metodoPago').value,
      chofer: els.chofer.value.trim(),
      ayudante: els.ayudante.value.trim(),
      // "Conseguido por" manda si alguien lo eligió a mano; si se deja en blanco y quien
      // registra el pedido tiene sesión de Promotor, se autocompleta con esa cuenta (mismo
      // comportamiento que antes) — así nadie deja de llevarse su comisión por descuido.
      promotorEmail: els.conseguidoPor.value || ((rolActivo === 'promotor' && usuarioActual) ? (personaDeCredencial(buscarCredencial(usuarioActual.email)) || {}).id || '' : ''),
      empresaId: empresaActivaId,
      tipoAlmacen: tipo,
      piso: tipo === 'Tanque Elevado' ? document.getElementById('piso').value : '-',
      dificultad: document.getElementById('dificultad').value,
      manguera: document.getElementById('manguera').value,
      notas: document.getElementById('notas').value
    };

    if(!datos.horaInicio || !datos.horaFin){
      els.horarioError.textContent = 'Completa la hora de inicio y la hora fin.';
      els.horarioError.hidden = false;
      return;
    }
    if(minutosDesdeMedianoche(datos.horaFin) <= minutosDesdeMedianoche(datos.horaInicio)){
      els.horarioError.textContent = 'La hora fin debe ser posterior a la hora de inicio.';
      els.horarioError.hidden = false;
      return;
    }
    var conflictoForm = encontrarConflictoHorario(datos.fecha, datos.horaInicio, datos.horaFin, editandoId);
    if(conflictoForm){
      els.horarioError.textContent = '⚠️ Este horario se cruza con "' + conflictoForm.cliente + '" (' +
        formatearHora12(conflictoForm.horaInicio) + ' – ' + formatearHora12(conflictoForm.horaFin) +
        '). Elige un horario a partir de las ' + formatearHora12(sumarMinutosHora(conflictoForm.horaFin, 1)) + '.';
      els.horarioError.hidden = false;
      return;
    }

    // Regla "Caja Negra": no repetir el mismo chofer 4+ veces seguidas con un cliente.
    // Bloquea salvo que el Administrador marque "Forzar". No aplica al EDITAR (el pedido
    // ya existe) ni si el chofer va "Sin asignar".
    if(!editandoId && datos.chofer){
      var vetadoCN = choferVetadoCajaNegra(datos.codigoCliente);
      var forzarCN = document.getElementById('cajaNegraForzar');
      if(vetadoCN === datos.chofer && !(forzarCN && forzarCN.checked)){
        evaluarCajaNegra(false);
        var sug = sugerirChoferCajaNegra(datos.codigoCliente, vetadoCN);
        els.horarioError.textContent = '⚠️ Caja Negra: ' + datos.chofer + ' ya atendió a este cliente ' +
          CAJA_NEGRA_MAX_SEGUIDAS + ' veces seguidas. Cambia a ' + (sug || 'otro chofer') +
          ', o marca "Forzar esta asignación".';
        els.horarioError.hidden = false;
        document.getElementById('cajaNegraAviso').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }

    if(editandoId){
      var p = pedidos.find(function(x){ return x.id === editandoId; });
      var cambioDeDia = p.fecha !== datos.fecha;
      Object.assign(p, datos);
      if(cambioDeDia) p.orden = siguienteOrden(p.fecha);
    } else {
      datos.id = siguienteId();
      datos.estado = 'Programado';
      datos.motivoCancelacion = '';
      datos.tiempos = tiemposVacios();
      datos.orden = siguienteOrden(datos.fecha);
      pedidos.push(datos);
      if(rolActivo === 'promotor' && nombrePromotor){
        afiliaciones[datos.id] = nombrePromotor;
        guardarAfiliaciones();
      }
    }

    var fechaDestino = datos.fecha;
    guardarPedidos();
    cancelarEdicion();
    seleccionarFecha(fechaDestino);
    // Ir siempre a "agenda" tras guardar daba un callejón sin salida al rol "promotor"
    // (que no tiene esa vista habilitada): se queda en su vista principal (para él,
    // "agendar" — listo para registrar el siguiente pedido); el resto de roles, que sí
    // tienen "agenda" habilitada, se comportan exactamente igual que antes.
    if(VISTAS_POR_ROL[rolActivo].tabs.indexOf('agenda') !== -1){
      irAVista('agenda');
    } else {
      irAVista(VISTAS_POR_ROL[rolActivo].defaultView);
    }
  });

  /* ---------- Copia de seguridad ---------- */
  var backupModal = document.getElementById('backupModal');
  var backupOut = document.getElementById('backupOut');
  var backupIn = document.getElementById('backupIn');
  var modalStatus = document.getElementById('modalStatus');

  document.getElementById('btnBackup').addEventListener('click', function(){
    backupOut.value = JSON.stringify(pedidos, null, 2);
    backupIn.value = '';
    modalStatus.textContent = '';
    modalStatus.className = 'modal-status';
    backupModal.hidden = false;
  });
  document.getElementById('btnCloseModal').addEventListener('click', function(){ backupModal.hidden = true; });
  backupModal.addEventListener('click', function(e){ if(e.target === backupModal) backupModal.hidden = true; });

  document.getElementById('btnCopy').addEventListener('click', function(){
    backupOut.select();
    var copiado = false;
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(backupOut.value);
        copiado = true;
      }
    }catch(e){}
    if(!copiado){
      try{ document.execCommand('copy'); copiado = true; }catch(e){}
    }
    modalStatus.textContent = copiado ? 'Copiado al portapapeles.' : 'No se pudo copiar automáticamente: selecciona el texto y copia con Ctrl+C.';
    modalStatus.className = 'modal-status ' + (copiado ? 'ok' : 'err');
  });

  document.getElementById('btnImport').addEventListener('click', function(){
    var texto = backupIn.value.trim();
    if(!texto){
      modalStatus.textContent = 'Pega primero el contenido de una copia exportada.';
      modalStatus.className = 'modal-status err';
      return;
    }
    var datos;
    try{ datos = JSON.parse(texto); }
    catch(e){
      modalStatus.textContent = 'Ese texto no es un JSON válido.';
      modalStatus.className = 'modal-status err';
      return;
    }
    if(!Array.isArray(datos)){
      modalStatus.textContent = 'El contenido debe ser una lista de pedidos.';
      modalStatus.className = 'modal-status err';
      return;
    }
    if(!confirm('Esto reemplazará los ' + pedidos.length + ' pedidos actuales por los ' + datos.length + ' de la copia. ¿Continuar?')) return;
    pedidos = migrarPedidos(datos);
    guardarPedidos();
    cancelarEdicion();
    renderTodo();
    modalStatus.textContent = 'Importado correctamente.';
    modalStatus.className = 'modal-status ok';
  });

  document.getElementById('btnPrint').addEventListener('click', function(){ window.print(); });

  /* ---------- Cancelación / retiro voluntario ---------- */
  var cancelModal = document.getElementById('cancelModal');
  var cancelMotivo = document.getElementById('cancelMotivo');
  var idParaCancelar = null;
  var estadoParaCancelar = null;

  function abrirModalCancelacion(id, estado){
    idParaCancelar = id;
    estadoParaCancelar = estado;
    document.getElementById('cancelModalTitle').textContent = estado === 'Cancelado' ? 'Cancelar servicio' : 'Registrar retiro voluntario';
    document.getElementById('cancelModalDesc').textContent = estado === 'Cancelado' ?
      'El pedido se marcará como cancelado: no genera ingreso ni sueldo por viaje. Puedes reabrirlo después si fue un error.' :
      'El cliente eligió retirarse del servicio. El pedido quedará registrado como retiro voluntario: no genera ingreso ni sueldo por viaje.';
    cancelMotivo.value = '';
    cancelModal.hidden = false;
  }
  function cerrarModalCancelacion(){ cancelModal.hidden = true; }
  document.getElementById('btnCloseCancelModal').addEventListener('click', cerrarModalCancelacion);
  document.getElementById('btnCerrarCancelModal').addEventListener('click', cerrarModalCancelacion);
  cancelModal.addEventListener('click', function(e){ if(e.target === cancelModal) cerrarModalCancelacion(); });
  document.getElementById('btnConfirmarCancelacion').addEventListener('click', function(){
    var p = pedidos.find(function(x){ return x.id === idParaCancelar; });
    if(p){
      p.estado = estadoParaCancelar;
      p.motivoCancelacion = cancelMotivo.value.trim();
      guardarPedidos();
      renderTodo();
    }
    cerrarModalCancelacion();
  });

  /* ---------- Postergar pedido (bloques de 15 min) ---------- */
  var postponeModal = document.getElementById('postponeModal');
  var postponeError = document.getElementById('postponeError');
  var idParaPostergar = null;

  function abrirModalPostergar(id){
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p) return;
    idParaPostergar = id;
    document.getElementById('postponeModalDesc').textContent =
      'Horario actual: ' + formatearHora12(p.horaInicio) + ' – ' + formatearHora12(p.horaFin) + '. Elige cuánto quieres postergarlo (la nueva hora se sincroniza de inmediato).';
    postponeError.hidden = true;
    document.getElementById('postponeCustom').value = '';
    postponeModal.hidden = false;
  }
  function cerrarModalPostergar(){ postponeModal.hidden = true; idParaPostergar = null; }
  function mostrarErrorPostergar(msg){
    postponeError.textContent = msg;
    postponeError.hidden = false;
  }
  document.getElementById('btnClosePostponeModal').addEventListener('click', cerrarModalPostergar);
  document.getElementById('btnCancelPostpone').addEventListener('click', cerrarModalPostergar);
  postponeModal.addEventListener('click', function(e){ if(e.target === postponeModal) cerrarModalPostergar(); });

  // Aplica el corrimiento de minutos a hora_inicio/hora_fin del pedido, valida que el
  // nuevo rango no choque con otro pedido activo del mismo día y, si todo va bien,
  // guarda (guardarPedidos ya sincroniza con Supabase si está conectado).
  function postergarPedido(id, minutos){
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p) return false;
    var nuevaInicio = sumarMinutosHora(p.horaInicio, minutos);
    var nuevaFin = sumarMinutosHora(p.horaFin, minutos);
    var conflicto = encontrarConflictoHorario(p.fecha, nuevaInicio, nuevaFin, p.id);
    if(conflicto){
      mostrarErrorPostergar('No se puede postergar: el nuevo horario (' + formatearHora12(nuevaInicio) + ' – ' + formatearHora12(nuevaFin) + ') se cruza con "' + conflicto.cliente + '" (' + formatearHora12(conflicto.horaInicio) + ' – ' + formatearHora12(conflicto.horaFin) + ').');
      return false;
    }
    p.horaInicio = nuevaInicio;
    p.horaFin = nuevaFin;
    guardarPedidos();
    renderTodo();
    cerrarModalPostergar();
    return true;
  }
  document.getElementById('postponeGrid').addEventListener('click', function(e){
    var btn = e.target.closest('.postpone-opt');
    if(!btn || !idParaPostergar) return;
    postergarPedido(idParaPostergar, parseInt(btn.dataset.min, 10));
  });
  document.getElementById('btnPostponeCustom').addEventListener('click', function(){
    if(!idParaPostergar) return;
    var val = parseInt(document.getElementById('postponeCustom').value, 10);
    if(!val || val <= 0 || val % 15 !== 0){
      mostrarErrorPostergar('Ingresa un número de minutos múltiplo de 15 (ej: 15, 30, 45, 60...).');
      return;
    }
    postergarPedido(idParaPostergar, val);
  });

  /* ---------- Vistas: Inicio / Agenda / Cotizar / Agendar / Contabilidad / Mi Perfil / Ajustes ---------- */
  var vistaActual = 'home';
  var VISTAS = ['home', 'agenda', 'cotizar', 'hub', 'agendar', 'ayudante', 'contabilidad', 'perfil', 'ajustes'];
  var ID_VISTA = { home: 'vistaHome', agenda: 'vistaAgenda', cotizar: 'vistaCotizar', hub: 'vistaHub', agendar: 'vistaAgendar', ayudante: 'vistaAyudante', contabilidad: 'vistaContabilidad', perfil: 'vistaPerfil', ajustes: 'vistaAjustes' };

  function irAVista(nombre, desdePop){
    if(VISTAS.indexOf(nombre) === -1) nombre = 'home';
    var mismaVista = nombre === vistaActual;
    var vistaAnterior = vistaActual;
    vistaActual = nombre;
    // Historial: cada cambio real de vista deja una entrada, para que el botón "atrás"
    // de Android (y el swipe-back) vuelvan a la vista anterior en vez de cerrar la app.
    // `desdePop` = true cuando el propio popstate nos trajo aquí (no re-empujar).
    if(!desdePop && !mismaVista){
      try{ history.pushState({ v: nombre }, '', location.pathname + '?vista=' + nombre); }catch(e){}
    }
    document.querySelectorAll('.view-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.view === nombre); });
    VISTAS.forEach(function(v){ document.getElementById(ID_VISTA[v]).hidden = v !== nombre; });
    // Rendimiento: el mapa de Leaflet (iniciarMapaHub()) solo tiene sentido vivo mientras se
    // ve el Hub Central — al salir de esa pestaña se destruye (Leaflet .remove(), listeners
    // incluidos) en vez de dejarlo corriendo oculto en el DOM; la próxima vez que se entre al
    // Hub Central, renderHub() reconstruye el cascarón desde cero y lo vuelve a inicializar.
    if(vistaAnterior === 'hub' && nombre !== 'hub') destruirMapaHub();
    if(nombre === 'contabilidad') renderContabilidad();
    if(nombre === 'agenda') renderTodo();
    if(nombre === 'perfil') renderPerfil();
    if(nombre === 'ajustes') renderAjustes();
    if(nombre === 'ayudante') renderAyudante();
    if(nombre === 'hub') renderHub();
    window.scrollTo(0, 0);
  }

  document.getElementById('viewTabs').addEventListener('click', function(e){
    var btn = e.target.closest('.view-tab');
    if(!btn) return;
    if(btn.dataset.view !== 'agendar') cancelarEdicion();
    irAVista(btn.dataset.view);
  });

  // Botón "atrás" (Android / swipe-back / navegador): 1º cierra un modal abierto,
  // si no, vuelve a la vista anterior del historial. Nunca cierra la app de golpe
  // salvo que ya no haya a dónde volver (lo maneja el navegador / Capacitor.App).
  function cerrarModalesAbiertos(){
    var n = 0;
    document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(function(m){ m.hidden = true; n++; });
    return n;
  }
  window.addEventListener('popstate', function(e){
    if(cerrarModalesAbiertos() > 0){
      // el "atrás" se usó para cerrar el modal: re-añade un estado para no gastar el back
      try{ history.pushState({ v: vistaActual }, '', location.pathname + '?vista=' + vistaActual); }catch(_){}
      return;
    }
    cancelarEdicion();
    var v = (e.state && e.state.v);
    var permitidas = (VISTAS_POR_ROL[rolActivo] || VISTAS_POR_ROL.cliente).tabs;
    if(!v || VISTAS.indexOf(v) === -1 || permitidas.indexOf(v) === -1){
      v = (VISTAS_POR_ROL[rolActivo] || VISTAS_POR_ROL.cliente).defaultView;
    }
    irAVista(v, true);
  });
  try{ history.replaceState({ v: vistaActual || 'home' }, ''); }catch(e){}

  document.getElementById('vistaHome').addEventListener('click', function(e){
    var card = e.target.closest('.home-card');
    if(!card) return;
    if(card.dataset.goto !== 'agendar') cancelarEdicion();
    irAVista(card.dataset.goto);
  });

  /* ---------- Selector de perfil / sesión simulada ---------- */
  // Solo oculta/muestra los puntos de entrada (tabs de la nav y tarjetas de Inicio) —
  // no bloquea la navegación programática (ej. el lápiz "Editar" de una tarjeta de la
  // Agenda sigue llevando a #vistaAgendar aunque esa tab esté oculta para el chofer),
  // coherente con que este control de acceso es simulado, no una autorización real.
  function actualizarTabsPorRol(){
    var permitidas = VISTAS_POR_ROL[rolActivo].tabs;
    document.querySelectorAll('.view-tab').forEach(function(b){
      b.hidden = permitidas.indexOf(b.dataset.view) === -1;
    });
    document.querySelectorAll('.home-card').forEach(function(c){
      c.hidden = permitidas.indexOf(c.dataset.goto) === -1;
    });
    // Botones que son atajos directos a una vista (no pasan por el nav ni por Inicio):
    // deben respetar el mismo permiso, si no serían una fuga del control simulado.
    document.getElementById('btnIrAgendar').hidden = permitidas.indexOf('agendar') === -1;
    // Copiar/reemplazar TODOS los pedidos es una acción de administración — no para "cliente".
    document.getElementById('btnBackup').hidden = rolActivo === 'cliente';
    // El switch de empresa (marketplace multiempresa) es un control de simulación para
    // Administradores — Chofer/Promotor ya pertenecen a una sola empresa implícitamente,
    // y Cliente no administra ninguna.
    document.getElementById('empresaSwitch').hidden = rolActivo !== 'admin';
  }

  function actualizarPromotorUI(){
    var esPromotor = rolActivo === 'promotor';
    document.getElementById('promotorBar').hidden = !esPromotor;
    if(esPromotor){
      // Con login real ya sabemos quién es (usuarioActual.email) — se usa como nombre de
      // promotor por defecto en vez de pedirlo a mano, aunque la persona lo puede editar.
      if(!nombrePromotor && usuarioActual && usuarioActual.email){
        guardarNombrePromotor(usuarioActual.email);
      }
      document.getElementById('promotorNombreInput').value = nombrePromotor;
      renderAfiliados();
    }
  }

  function aplicarRol(nuevoRol){
    if(!VISTAS_POR_ROL[nuevoRol]) return;
    guardarRol(nuevoRol);
    actualizarTabsPorRol();
    actualizarPromotorUI();
    var permitidas = VISTAS_POR_ROL[rolActivo].tabs;
    if(permitidas.indexOf(vistaActual) === -1){
      irAVista(VISTAS_POR_ROL[rolActivo].defaultView);
    } else {
      // La vista no cambia, pero su contenido sí depende del rol (tarjetas de solo
      // lectura para "cliente", tile de pago para "chofer") — renderTodo() ya solo
      // toca en el DOM los nodos que realmente cambiaron, así que esto no parpadea.
      renderTodo();
    }
  }

  /* ---------- Formulario del promotor: nombre y "Mis Pedidos como Promotor" ---------- */
  document.getElementById('promotorNombreInput').addEventListener('input', function(){
    guardarNombrePromotor(this.value.trim());
    if(document.querySelector('.promotor-sub .sub-tab[data-promotorsub="mios"]').classList.contains('active')){
      renderAfiliados();
    }
  });

  document.getElementById('promotorSub').addEventListener('click', function(e){
    var btn = e.target.closest('.sub-tab');
    if(!btn) return;
    document.querySelectorAll('#promotorSub .sub-tab').forEach(function(b){ b.classList.toggle('active', b === btn); });
    var esMios = btn.dataset.promotorsub === 'mios';
    document.getElementById('promotorFormWrap').hidden = esMios;
    document.getElementById('afiliadosLista').hidden = !esMios;
    if(esMios) renderAfiliados();
  });

  function renderAfiliados(){
    var cont = document.getElementById('afiliadosLista');
    if(!nombrePromotor){
      cont.innerHTML = '<div class="empty-state">Escribe tu nombre arriba para ver los pedidos que registraste.</div>';
      return;
    }
    var propios = pedidos.filter(function(p){ return afiliaciones[p.id] === nombrePromotor; });
    if(propios.length === 0){
      cont.innerHTML = '<div class="empty-state">Aún no registraste ningún pedido con este nombre.</div>';
      return;
    }
    propios.sort(function(a, b){ return (b.fecha + b.horaInicio).localeCompare(a.fecha + a.horaInicio); });
    cont.innerHTML = propios.map(function(p){
      var statusClass = 'status-' + p.estado.replace(/ /g, '-');
      return '' +
        '<div class="order-card" data-id="' + escapeHtml(p.id) + '">' +
          '<div class="order-head">' +
            '<div class="order-time">📅 ' + escapeHtml(p.fecha) + ' · 🕒 ' + formatearHora12(p.horaInicio) + ' – ' + formatearHora12(p.horaFin) + '</div>' +
            '<div class="order-price">S/. ' + (isFinite(Number(p.precio)) ? Number(p.precio).toFixed(2) : '0.00') + '</div>' +
          '</div>' +
          '<div class="order-client">' + escapeHtml(p.cliente) + '</div>' +
          '<div class="order-ubicacion">📍 ' + escapeHtml(p.ubicacion || 'Sin ubicación registrada') + '</div>' +
          '<div class="order-foot"><span class="status-pill ' + statusClass + '">' + escapeHtml(p.estado) + '</span> <span class="order-id">' + escapeHtml(p.id) + '</span></div>' +
        '</div>';
    }).join('');
  }

  document.getElementById('btnIrAgendar').addEventListener('click', function(){
    cancelarEdicion();
    irAVista('agendar');
  });

  /* ---------- Gastos ---------- */
  var GASTOS_KEY = 'sedeCentral_gastos_v1';
  function sanearGasto(g){
    if(g && typeof g === 'object'){
      if(g.id !== undefined) g.id = sanText(g.id, 80);
      if(g.categoria !== undefined) g.categoria = sanText(g.categoria, 120);
      if(g.descripcion !== undefined) g.descripcion = sanText(g.descripcion, 400);
      if(g.empresaId !== undefined) g.empresaId = sanText(g.empresaId, 80);
    }
    return g;
  }
  function cargarGastos(){
    try{
      var raw = localStorage.getItem(GASTOS_KEY);
      if(raw){
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.map(sanearGasto) : [];
      }
    }catch(e){}
    return [];
  }
  var _firmasGastos = {};
  function guardarGastos(){
    if(!supaAplicandoRemoto) sellarCambios(gastos, _firmasGastos);
    try{ localStorage.setItem(GASTOS_KEY, JSON.stringify(gastos)); }catch(e){}
    if(supaListo && !supaAplicandoRemoto) reconciliarRemoto('gastos', gastos, gastoARemoto);
  }
  function siguienteIdGasto(){
    var maxNum = 0;
    gastos.forEach(function(g){
      var m = /^GAS-(\d+)$/.exec(g.id);
      if(m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    return 'GAS-' + String(maxNum + 1).padStart(3, '0');
  }
  var gastos = cargarGastos();

  var gastoForm = document.getElementById('gastoForm');
  document.getElementById('gastoFecha').value = HOY;
  gastoForm.addEventListener('submit', function(e){
    e.preventDefault();
    gastos.push({
      id: siguienteIdGasto(),
      fecha: document.getElementById('gastoFecha').value || HOY,
      categoria: document.getElementById('gastoCategoria').value,
      descripcion: document.getElementById('gastoDescripcion').value,
      monto: parseFloat(document.getElementById('gastoMonto').value) || 0,
      empresaId: empresaActivaId
    });
    guardarGastos();
    gastoForm.reset();
    document.getElementById('gastoFecha').value = HOY;
    renderContabilidad();
  });
  document.getElementById('listaGastos').addEventListener('click', function(e){
    var btn = e.target.closest('[data-del-gasto]');
    if(!btn) return;
    if(!confirm('¿Eliminar este gasto?')) return;
    gastos = gastos.filter(function(g){ return g.id !== btn.dataset.delGasto; });
    guardarGastos();
    renderContabilidad();
  });

  /* ---------- Periodo de la vista de contabilidad ---------- */
  var periodoActual = 'hoy';
  document.getElementById('periodoGroup').addEventListener('click', function(e){
    var btn = e.target.closest('.filter-btn');
    if(!btn) return;
    document.querySelectorAll('#periodoGroup .filter-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    periodoActual = btn.dataset.periodo;
    document.getElementById('rangoDesde').value = '';
    document.getElementById('rangoHasta').value = '';
    renderContabilidad();
  });
  var renderContabilidadDebounced = debounce(renderContabilidad, 220);
  document.getElementById('rangoDesde').addEventListener('change', renderContabilidadDebounced);
  document.getElementById('rangoHasta').addEventListener('change', renderContabilidadDebounced);

  function rangoDelPeriodo(){
    var desde = document.getElementById('rangoDesde').value;
    var hasta = document.getElementById('rangoHasta').value;
    if(desde || hasta) return { desde: desde || '0000-01-01', hasta: hasta || '9999-12-31' };
    if(periodoActual === 'hoy') return { desde: HOY, hasta: HOY };
    if(periodoActual === 'semana') return { desde: sumarDias(HOY, -6), hasta: HOY };
    if(periodoActual === 'mes') return { desde: HOY.slice(0,8) + '01', hasta: HOY };
    return { desde: '0000-01-01', hasta: '9999-12-31' };
  }

  function pedidosDelPeriodo(){
    var r = rangoDelPeriodo();
    return pedidos.filter(function(p){ return p.fecha >= r.desde && p.fecha <= r.hasta && (p.empresaId || 'kunturmasha') === empresaActivaId; });
  }
  function gastosDelPeriodo(){
    var r = rangoDelPeriodo();
    return gastos.filter(function(g){ return g.fecha >= r.desde && g.fecha <= r.hasta && (g.empresaId || 'kunturmasha') === empresaActivaId; });
  }

  /* ---------- Sistema contable simulado ---------- */
  var CUENTAS = {
    '10': 'Caja y Bancos',
    '12': 'Cuentas por Cobrar Comerciales — Clientes',
    '50': 'Capital Social',
    '59': 'Resultados Acumulados',
    '62': 'Gastos de Personal',
    '63': 'Gastos de Servicios Prestados por Terceros',
    '65': 'Otros Gastos de Gestión',
    '70': 'Ventas — Servicio de Transporte de Agua'
  };
  var CATEGORIA_CUENTA = {
    'Combustible': '63',
    'Mantenimiento': '63',
    'Taxi supervisión': '63',
    'Pasajes / movilidad': '65',
    'Desayuno': '65',
    'Almuerzo': '65',
    'Cena': '65',
    'Otros': '65'
  };
  function nombreCuenta(codigo){ return codigo + ' — ' + (CUENTAS[codigo] || 'Cuenta sin definir'); }

  // Construye los asientos (líneas de Debe/Haber) del Libro Diario a partir de pedidos y gastos.
  function construirAsientos(listaPedidos, listaGastos){
    var entradas = [];
    listaPedidos.forEach(function(p){
      if(esFallido(p)) return; // cancelados / retiros voluntarios: no se prestó el servicio, sin asiento
      var glosaCliente = p.id + ' — ' + (p.cliente || 'cliente');
      if(p.estado === 'Completado'){
        entradas.push({ fecha:p.fecha, glosa:'Venta de servicio (cobrado) — ' + glosaCliente, cuenta:'10', debe:Number(p.precio)||0, haber:0 });
        entradas.push({ fecha:p.fecha, glosa:'Venta de servicio (cobrado) — ' + glosaCliente, cuenta:'70', debe:0, haber:Number(p.precio)||0 });
        var mo = manoDeObra(p.precio, p.empresaId);
        var totalSueldo = mo.chofer + mo.ayudante;
        var quienes = [p.chofer, p.ayudante].filter(Boolean).join(' / ');
        var detalleSueldo = 'chofer S/.' + mo.chofer.toFixed(2) + ' + ayudante S/.' + mo.ayudante.toFixed(2);
        entradas.push({ fecha:p.fecha, glosa:'Sueldo por viaje completado — ' + p.id + ' (' + detalleSueldo + ')' + (quienes ? ' — ' + quienes : ''), cuenta:'62', debe:totalSueldo, haber:0 });
        entradas.push({ fecha:p.fecha, glosa:'Sueldo por viaje completado — ' + p.id, cuenta:'10', debe:0, haber:totalSueldo });
      } else {
        entradas.push({ fecha:p.fecha, glosa:'Venta de servicio (por cobrar) — ' + glosaCliente, cuenta:'12', debe:Number(p.precio)||0, haber:0 });
        entradas.push({ fecha:p.fecha, glosa:'Venta de servicio (por cobrar) — ' + glosaCliente, cuenta:'70', debe:0, haber:Number(p.precio)||0 });
      }
    });
    // Sueldo fijo diario de chofer/ayudante (modalidad "fijo_dia", ver configPagosDe()): se
    // paga una sola vez por día con al menos un viaje completado de ESTA empresa (todos los
    // pedidos que llegan aquí ya vienen filtrados a empresaActivaId, ver pedidosDelPeriodo()),
    // no una vez por viaje — por eso queda fuera del forEach de arriba, agrupado por fecha.
    var cfgAsientos = configPagosDe(empresaActivaId);
    if(cfgAsientos.choferModalidad === 'fijo_dia' || cfgAsientos.ayudanteModalidad === 'fijo_dia'){
      var diasCompletados = Array.from(new Set(listaPedidos.filter(function(p){ return p.estado === 'Completado'; }).map(function(p){ return p.fecha; })));
      diasCompletados.forEach(function(fecha){
        var totalFijo = (cfgAsientos.choferModalidad === 'fijo_dia' ? Number(cfgAsientos.choferMonto) || 0 : 0) +
                        (cfgAsientos.ayudanteModalidad === 'fijo_dia' ? Number(cfgAsientos.ayudanteMonto) || 0 : 0);
        if(totalFijo <= 0) return;
        entradas.push({ fecha:fecha, glosa:'Sueldo fijo diario (chofer/ayudante) — ' + fecha, cuenta:'62', debe:totalFijo, haber:0 });
        entradas.push({ fecha:fecha, glosa:'Sueldo fijo diario (chofer/ayudante) — ' + fecha, cuenta:'10', debe:0, haber:totalFijo });
      });
    }
    listaGastos.forEach(function(g){
      var cuenta = CATEGORIA_CUENTA[g.categoria] || '65';
      // g.categoria/descripcion/id ya vienen saneados (sanearGasto/gastoDesdeRemoto) y
      // e.glosa se escapa de nuevo en cada render (ver renderMayor/renderDiario) — no
      // escapar aquí para no duplicar entidades (&amp;amp;) en la exportación CSV.
      var glosa = g.categoria + (g.descripcion ? ' — ' + g.descripcion : '') + ' (' + g.id + ')';
      entradas.push({ fecha:g.fecha, glosa:glosa, cuenta:cuenta, debe:Number(g.monto)||0, haber:0 });
      entradas.push({ fecha:g.fecha, glosa:glosa, cuenta:'10', debe:0, haber:Number(g.monto)||0 });
    });
    entradas.sort(function(a,b){ return a.fecha.localeCompare(b.fecha); });
    return entradas;
  }
  function sumaCuenta(entradas, cuenta, campo){
    return entradas.filter(function(e){ return e.cuenta === cuenta; }).reduce(function(s,e){ return s + e[campo]; }, 0);
  }
  function asientosDelPeriodo(){ return construirAsientos(pedidosDelPeriodo(), gastosDelPeriodo()); }
  function asientosTodos(){ return construirAsientos(pedidos, gastos); }

  function subtitutoPeriodo(){
    var r = rangoDelPeriodo();
    if(r.desde === r.hasta) return 'Periodo: ' + r.desde;
    if(r.desde === '0000-01-01') return 'Periodo: todo el historial';
    return 'Periodo: ' + r.desde + ' al ' + r.hasta;
  }

  var subVistaContable = 'resumen';
  var ID_SUBVISTA = { resumen:'subResumen', diario:'subDiario', mayor:'subMayor', resultados:'subResultados', balance:'subBalance', flujo:'subFlujo', eficiencia:'subEficiencia' };
  document.getElementById('contSubnav').addEventListener('click', function(e){
    var btn = e.target.closest('.sub-tab');
    if(!btn) return;
    subVistaContable = btn.dataset.sub;
    document.querySelectorAll('.sub-tab').forEach(function(b){ b.classList.toggle('active', b === btn); });
    Object.keys(ID_SUBVISTA).forEach(function(k){
      document.getElementById(ID_SUBVISTA[k]).hidden = k !== subVistaContable;
    });
    document.getElementById('contToolbar').hidden = subVistaContable === 'balance';
    document.getElementById('statsContables').hidden = subVistaContable === 'balance' || subVistaContable === 'eficiencia';
    renderContabilidad();
  });

  function renderContabilidad(){
    if(subVistaContable === 'resumen') renderResumenContable();
    else if(subVistaContable === 'diario') renderLibroDiario();
    else if(subVistaContable === 'mayor') renderLibroMayor();
    else if(subVistaContable === 'resultados') renderEstadoResultados();
    else if(subVistaContable === 'balance') renderBalanceGeneral();
    else if(subVistaContable === 'flujo') renderFlujoCaja();
    else if(subVistaContable === 'eficiencia') renderEficiencia();
  }

  function renderResumenContable(){
    var pDelPeriodo = pedidosDelPeriodo();
    var gDelPeriodo = gastosDelPeriodo();
    var cobrado = pDelPeriodo.filter(function(p){ return p.estado === 'Completado'; })
      .reduce(function(s,p){ return s + Number(p.precio||0); }, 0);
    var porCobrar = pDelPeriodo.filter(esAbierto)
      .reduce(function(s,p){ return s + Number(p.precio||0); }, 0);
    var fallidosPeriodo = pDelPeriodo.filter(esFallido).length;
    var totalGastos = gDelPeriodo.reduce(function(s,g){ return s + Number(g.monto||0); }, 0);
    var balance = cobrado - totalGastos;

    var tiles = [
      { label: 'Viajes en el periodo', value: pDelPeriodo.length },
      { label: 'Cobrado', value: 'S/. ' + cobrado.toFixed(2), cls:'good' },
      { label: 'Por cobrar', value: 'S/. ' + porCobrar.toFixed(2), cls:'accent' },
      { label: 'Gastos', value: 'S/. ' + totalGastos.toFixed(2) },
      { label: 'Balance neto', value: 'S/. ' + balance.toFixed(2), cls: balance >= 0 ? 'good' : '' },
      { label: 'Cancelados / retirados', value: fallidosPeriodo, cls: fallidosPeriodo ? 'bad' : '' }
    ];
    document.getElementById('statsContables').innerHTML = tiles.map(function(t){
      return '<div class="stat-tile ' + (t.cls||'') + '"><div class="label">' + t.label + '</div><div class="value mono">' + t.value + '</div></div>';
    }).join('');

    // Gastos: lista
    var listaGastos = document.getElementById('listaGastos');
    if(gDelPeriodo.length === 0){
      listaGastos.innerHTML = '<div class="empty-state">Sin gastos en este periodo.</div>';
    } else {
      var gOrdenados = gDelPeriodo.slice().sort(function(a,b){ return b.fecha.localeCompare(a.fecha); });
      listaGastos.innerHTML = gOrdenados.map(function(g){
        return '<div class="gasto-row">' +
          '<div class="g-info"><span class="g-cat">' + escapeHtml(g.categoria) + ' · <span class="mono">' + g.fecha + '</span></span>' +
          (g.descripcion ? '<span class="g-desc">' + escapeHtml(g.descripcion) + '</span>' : '') + '</div>' +
          '<div class="g-monto">S/. ' + Number(g.monto).toFixed(2) + '</div>' +
          '<button class="btn-icon danger" data-del-gasto="' + escapeHtml(g.id) + '" title="Eliminar">🗑</button>' +
        '</div>';
      }).join('');
    }

    // Tabla de pedidos (registro tipo Excel)
    var tbody = document.querySelector('#tablaPedidos tbody');
    var pOrdenados = pDelPeriodo.slice().sort(function(a,b){ return (a.fecha+String(a.orden||0)).localeCompare(b.fecha+String(b.orden||0)); });
    if(pOrdenados.length === 0){
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted); text-align:center;">Sin pedidos en este periodo.</td></tr>';
    } else {
      tbody.innerHTML = pOrdenados.map(function(p){
        return '<tr><td class="mono">' + escapeHtml(p.fecha) + '</td><td class="mono">' + escapeHtml(p.id) + '</td><td>' + escapeHtml(p.cliente) +
          '</td><td class="mono">' + escapeHtml(p.codigoCliente||'') + '</td><td class="mono">' + escapeHtml(p.telefono||'') + '</td><td>' + escapeHtml(p.ubicacion||'') + '</td><td class="mono">S/. ' + (isFinite(Number(p.precio)) ? Number(p.precio).toFixed(2) : '0.00') +
          '</td><td>' + escapeHtml(p.estado) + '</td></tr>';
      }).join('');
    }

    document.getElementById('copyStatus').textContent = '';
  }

  function renderLibroDiario(){
    var entradas = asientosDelPeriodo();
    var tbody = document.querySelector('#tablaDiario tbody');
    var tfoot = document.querySelector('#tablaDiario tfoot');
    if(entradas.length === 0){
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted); text-align:center;">Sin movimientos en este periodo.</td></tr>';
      tfoot.innerHTML = '';
    } else {
      tbody.innerHTML = entradas.map(function(e){
        return '<tr><td class="mono">' + e.fecha + '</td><td>' + escapeHtml(e.glosa) + '</td><td>' + nombreCuenta(e.cuenta) +
          '</td><td class="num">' + (e.debe ? 'S/. ' + e.debe.toFixed(2) : '') + '</td><td class="num">' + (e.haber ? 'S/. ' + e.haber.toFixed(2) : '') + '</td></tr>';
      }).join('');
      var totalDebe = entradas.reduce(function(s,e){ return s + e.debe; }, 0);
      var totalHaber = entradas.reduce(function(s,e){ return s + e.haber; }, 0);
      tfoot.innerHTML = '<tr><td colspan="3">Totales — ' + (Math.abs(totalDebe - totalHaber) < 0.005 ? 'Cuadra ✓' : 'No cuadra ✗') +
        '</td><td class="num">S/. ' + totalDebe.toFixed(2) + '</td><td class="num">S/. ' + totalHaber.toFixed(2) + '</td></tr>';
    }
    document.getElementById('diarioStatus').textContent = '';
  }

  function renderLibroMayor(){
    var entradas = asientosDelPeriodo();
    var cont = document.getElementById('cuentasMayor');
    var codigos = Object.keys(CUENTAS).filter(function(c){ return entradas.some(function(e){ return e.cuenta === c; }); });
    if(codigos.length === 0){
      cont.innerHTML = '<div class="empty-state">Sin movimientos en este periodo.</div>';
    } else {
      cont.innerHTML = codigos.map(function(c){
        var movs = entradas.filter(function(e){ return e.cuenta === c; });
        var saldo = movs.reduce(function(s,e){ return s + e.debe - e.haber; }, 0);
        var filas = movs.map(function(e){
          return '<tr><td class="mono">' + e.fecha + '</td><td>' + escapeHtml(e.glosa) + '</td><td class="num">' + (e.debe ? 'S/. ' + e.debe.toFixed(2) : '') +
            '</td><td class="num">' + (e.haber ? 'S/. ' + e.haber.toFixed(2) : '') + '</td></tr>';
        }).join('');
        return '<div class="cuenta-mayor"><h3>' + nombreCuenta(c) + '<span class="saldo">Saldo: S/. ' + saldo.toFixed(2) + (saldo < 0 ? ' (acreedor)' : ' (deudor)') + '</span></h3>' +
          '<table class="tabla-registro mono-tabla"><thead><tr><th>Fecha</th><th>Glosa</th><th class="num">Debe</th><th class="num">Haber</th></tr></thead><tbody>' + filas + '</tbody></table></div>';
      }).join('');
    }
    document.getElementById('mayorStatus').textContent = '';
  }

  function filaEstado(etiqueta, monto, clases){
    return '<tr class="' + (clases||'') + '"><td>' + etiqueta + '</td><td>S/. ' + monto.toFixed(2) + '</td></tr>';
  }

  function renderEstadoResultados(){
    document.getElementById('resultadosPeriodo').textContent = subtitutoPeriodo() + ' · cuenta de resultados (no incluye impuestos ni IGV)';
    var entradas = asientosDelPeriodo();
    var ventas = sumaCuenta(entradas, '70', 'haber');
    var gPersonal = sumaCuenta(entradas, '62', 'debe');
    var gServicios = sumaCuenta(entradas, '63', 'debe');
    var gOtros = sumaCuenta(entradas, '65', 'debe');
    var totalGastos = gPersonal + gServicios + gOtros;
    var utilidad = ventas - totalGastos;
    var html = '<tbody>' +
      filaEstado('Ventas — Servicio de transporte de agua', ventas) +
      '<tr class="fila-sub"><td colspan="2">Gastos operativos</td></tr>' +
      filaEstado('Gastos de personal (sueldos chofer y ayudante)', gPersonal, 'fila-indent') +
      filaEstado('Gastos de servicios prestados por terceros', gServicios, 'fila-indent') +
      filaEstado('Otros gastos de gestión', gOtros, 'fila-indent') +
      filaEstado('Total gastos operativos', totalGastos, 'fila-total') +
      filaEstado('Utilidad operativa del periodo', utilidad, 'fila-total') +
      '</tbody>';
    document.getElementById('tablaResultados').innerHTML = html;
    document.getElementById('resultadosStatus').textContent = '';
  }

  function renderBalanceGeneral(){
    document.getElementById('balanceFecha').textContent = 'Balance General al ' + HOY + ' · acumulado de todo el historial registrado';
    var entradas = asientosTodos();
    var caja = sumaCuenta(entradas, '10', 'debe') - sumaCuenta(entradas, '10', 'haber');
    var ctasCobrar = sumaCuenta(entradas, '12', 'debe') - sumaCuenta(entradas, '12', 'haber');
    var ventas = sumaCuenta(entradas, '70', 'haber');
    var gastosTot = sumaCuenta(entradas, '62', 'debe') + sumaCuenta(entradas, '63', 'debe') + sumaCuenta(entradas, '65', 'debe');
    var utilidadAcumulada = ventas - gastosTot;
    var capitalSocial = 0;
    var totalActivo = caja + ctasCobrar;
    var totalPatrimonio = capitalSocial + utilidadAcumulada;
    var cuadra = Math.abs(totalActivo - totalPatrimonio) < 0.005;

    var colActivo = '<h3>Activo</h3><table class="tabla-estado"><tbody>' +
      filaEstado('Caja y Bancos', caja) +
      filaEstado('Cuentas por Cobrar Comerciales', ctasCobrar) +
      filaEstado('Total Activo', totalActivo, 'fila-total') +
      '</tbody></table>';
    var colPasivo = '<h3>Pasivo y Patrimonio</h3><table class="tabla-estado"><tbody>' +
      '<tr class="fila-sub"><td colspan="2">No se registran pasivos (préstamos, tributos por pagar) en esta simulación.</td></tr>' +
      filaEstado('Capital Social (por definir con el contador)', capitalSocial) +
      filaEstado('Resultados Acumulados', utilidadAcumulada) +
      filaEstado('Total Patrimonio', totalPatrimonio, 'fila-total') +
      '</tbody></table>';
    document.getElementById('balanceCols').innerHTML = colActivo + colPasivo;
    var chk = document.querySelector('#subBalance .balance-check');
    if(!chk){
      chk = document.createElement('p');
      chk.className = 'balance-check';
      document.getElementById('balanceCols').after(chk);
    }
    chk.className = 'balance-check ' + (cuadra ? 'ok' : 'bad');
    chk.textContent = cuadra ? '✓ El balance cuadra: Activo = Pasivo + Patrimonio.' : '✗ El balance no cuadra — revisa los datos.';
    document.getElementById('balanceStatus').textContent = '';
  }

  function renderFlujoCaja(){
    document.getElementById('flujoPeriodo').textContent = subtitutoPeriodo() + ' · movimientos de efectivo (caja), no incluye cuentas por cobrar';
    var entradas = asientosDelPeriodo();
    var ingresos = sumaCuenta(entradas, '10', 'debe');
    var egresosPersonal = sumaCuenta(entradas, '62', 'debe');
    var egresosServicios = sumaCuenta(entradas, '63', 'debe');
    var egresosOtros = sumaCuenta(entradas, '65', 'debe');
    var totalEgresos = egresosPersonal + egresosServicios + egresosOtros;
    var flujoNeto = ingresos - totalEgresos;
    var html = '<tbody>' +
      filaEstado('Ingresos de efectivo — cobros por viajes completados', ingresos) +
      '<tr class="fila-sub"><td colspan="2">Egresos de efectivo</td></tr>' +
      filaEstado('Sueldos pagados (chofer y ayudante)', egresosPersonal, 'fila-indent') +
      filaEstado('Servicios de terceros pagados', egresosServicios, 'fila-indent') +
      filaEstado('Otros gastos de gestión pagados', egresosOtros, 'fila-indent') +
      filaEstado('Total egresos de efectivo', totalEgresos, 'fila-total') +
      filaEstado('Flujo neto de caja del periodo', flujoNeto, 'fila-total') +
      '</tbody>';
    document.getElementById('tablaFlujo').innerHTML = html;
    document.getElementById('flujoStatus').textContent = '';
  }

  function pedidosConTiempoCompleto(lista){
    return lista.filter(function(p){
      return Array.isArray(p.tiempos) && p.tiempos.length === ETAPAS.length &&
        p.tiempos[0] && p.tiempos[0].inicio && p.tiempos[ETAPAS.length-1] && p.tiempos[ETAPAS.length-1].fin;
    });
  }
  function duracionTotalPedido(p){
    return new Date(p.tiempos[ETAPAS.length-1].fin) - new Date(p.tiempos[0].inicio);
  }
  function duracionEtapaPedido(p, idx){
    var et = p.tiempos[idx];
    if(!et || !et.inicio || !et.fin) return null;
    return new Date(et.fin) - new Date(et.inicio);
  }

  function renderEficiencia(){
    document.getElementById('eficienciaPeriodo').textContent = subtitutoPeriodo() + ' · solo viajes completados con tiempos registrados de inicio a fin';
    var medidos = pedidosConTiempoCompleto(pedidosDelPeriodo());
    var tbody = document.querySelector('#tablaEficiencia tbody');
    if(medidos.length === 0){
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted); text-align:center;">Sin viajes con tiempos completos en este periodo.</td></tr>';
    } else {
      tbody.innerHTML = medidos.map(function(p){
        var etapasCols = ETAPAS.map(function(_, idx){ return '<td class="num">' + formatearDuracionMin(duracionEtapaPedido(p, idx)) + '</td>'; }).join('');
        return '<tr><td class="mono">' + p.fecha + '</td><td class="mono">' + p.id + '</td><td>' + escapeHtml(p.cliente) + '</td><td>' + escapeHtml(p.chofer || '—') + '</td>' +
          etapasCols + '<td class="num" style="font-weight:700;">' + formatearDuracionMin(duracionTotalPedido(p)) + '</td></tr>';
      }).join('');
    }

    var porChofer = {};
    medidos.forEach(function(p){
      var nombre = p.chofer || 'Sin asignar';
      if(!porChofer[nombre]) porChofer[nombre] = { viajes: 0, totalMs: 0 };
      porChofer[nombre].viajes++;
      porChofer[nombre].totalMs += duracionTotalPedido(p);
    });
    var nombresChofer = Object.keys(porChofer).sort(function(a,b){
      return (porChofer[a].totalMs / porChofer[a].viajes) - (porChofer[b].totalMs / porChofer[b].viajes);
    });
    var tbodyRanking = document.querySelector('#tablaRankingChoferes tbody');
    tbodyRanking.innerHTML = nombresChofer.length === 0 ?
      '<tr><td colspan="3" style="color:var(--muted); text-align:center;">Sin datos.</td></tr>' :
      nombresChofer.map(function(nombre){
        var st = porChofer[nombre];
        return '<tr><td>' + escapeHtml(nombre) + '</td><td class="num">' + st.viajes + '</td><td class="num">' + formatearDuracionMin(st.totalMs / st.viajes) + '</td></tr>';
      }).join('');

    document.getElementById('eficienciaStatus').textContent = '';
  }

  function copiarAlPortapapeles(texto){
    var ok = false;
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(texto); ok = true; }
    }catch(e){}
    if(!ok){
      try{
        var ta = document.createElement('textarea');
        ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ok = true;
      }catch(e){}
    }
    return ok;
  }

  document.getElementById('btnCopiarPedidos').addEventListener('click', function(){
    var filas = [['Fecha','ID','Cliente','Código cliente','Teléfono','Ubicación','Precio','Estado','Motivo cancelación / retiro']];
    pedidosDelPeriodo().forEach(function(p){
      filas.push([p.fecha, p.id, p.cliente, p.codigoCliente || '', p.telefono || '', p.ubicacion || '', Number(p.precio).toFixed(2), p.estado, p.motivoCancelacion || '']);
    });
    var tsv = filas.map(function(f){ return f.join('\t'); }).join('\n');
    var ok = copiarAlPortapapeles(tsv);
    document.getElementById('copyStatus').textContent = ok ?
      'Copiado — pega con Ctrl+V en Excel o Google Sheets.' : 'No se pudo copiar automáticamente; selecciona la tabla manualmente.';
  });
  document.getElementById('btnCopiarGastos').addEventListener('click', function(){
    var filas = [['Fecha','ID','Categoría','Descripción','Monto']];
    gastosDelPeriodo().forEach(function(g){
      filas.push([g.fecha, g.id, g.categoria, g.descripcion || '', Number(g.monto).toFixed(2)]);
    });
    var tsv = filas.map(function(f){ return f.join('\t'); }).join('\n');
    var ok = copiarAlPortapapeles(tsv);
    document.getElementById('copyStatus').textContent = ok ?
      'Copiado — pega con Ctrl+V en Excel o Google Sheets.' : 'No se pudo copiar automáticamente; selecciona la tabla manualmente.';
  });

  function copiarTsvADocumento(filas, idBoton, idStatus){
    var tsv = filas.map(function(f){ return f.join('\t'); }).join('\n');
    var ok = copiarAlPortapapeles(tsv);
    document.getElementById(idStatus).textContent = ok ?
      'Copiado — pega con Ctrl+V en Excel o Google Sheets.' : 'No se pudo copiar automáticamente; selecciona la tabla manualmente.';
  }

  /* ---------- Descargar contabilidad como un único CSV ---------- */
  // Escapa un campo para CSV (RFC 4180): entrecomilla si hay coma, comilla o salto,
  // y duplica las comillas internas.
  function csvCampo(v){
    var s = (v == null) ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function filasACSV(filas){
    return filas.map(function(f){ return f.map(csvCampo).join(','); }).join('\r\n');
  }
  function descargarArchivo(nombre, contenido, mime){
    try{
      var blob = new Blob(['﻿' + contenido], { type: (mime || 'text/csv') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = nombre;
      document.body.appendChild(a); a.click();
      setTimeout(function(){ a.remove(); URL.revokeObjectURL(url); }, 400);
      return true;
    }catch(e){ return false; }
  }
  function nombrePeriodoArchivo(){
    var r = rangoDelPeriodo();
    var d = (r.desde === '0000-01-01') ? 'inicio' : r.desde;
    var h = (r.hasta === '9999-12-31') ? 'hoy' : r.hasta;
    return d + '_a_' + h;
  }
  function exportarContabilidadCSV(){
    var empresa = buscarEmpresa(empresaActivaId);
    var bloques = [];
    bloques.push([['WaterCore Space — Contabilidad (simulación)']]);
    bloques.push([['Empresa', empresa.nombre], ['Periodo', nombrePeriodoArchivo()], ['Generado', new Date().toISOString()]]);

    var fP = [['— PEDIDOS —'], ['Fecha','ID','Cliente','Código','Teléfono','Ubicación','Volumen m³','Método pago','Precio','Chofer','Ayudante','Estado','Motivo']];
    pedidosDelPeriodo().forEach(function(p){
      fP.push([p.fecha, p.id, p.cliente, p.codigoCliente||'', p.telefono||'', p.ubicacion||'',
        (p.volumenM3||''), p.metodoPago||'', (isFinite(Number(p.precio))?Number(p.precio).toFixed(2):''),
        p.chofer||'', p.ayudante||'', p.estado, p.motivoCancelacion||'']);
    });
    bloques.push(fP);

    var fG = [['— GASTOS —'], ['Fecha','ID','Categoría','Descripción','Monto']];
    gastosDelPeriodo().forEach(function(g){ fG.push([g.fecha, g.id, g.categoria, g.descripcion||'', (isFinite(Number(g.monto))?Number(g.monto).toFixed(2):'')]); });
    bloques.push(fG);

    var asientos = asientosDelPeriodo();
    var fD = [['— LIBRO DIARIO —'], ['Fecha','Glosa','Cuenta','Debe','Haber']];
    asientos.forEach(function(e){ fD.push([e.fecha, e.glosa, nombreCuenta(e.cuenta), e.debe?e.debe.toFixed(2):'', e.haber?e.haber.toFixed(2):'']); });
    bloques.push(fD);

    var fM = [['— LIBRO MAYOR —'], ['Cuenta','Fecha','Glosa','Debe','Haber','Saldo cuenta']];
    Object.keys(CUENTAS).forEach(function(c){
      var movs = asientos.filter(function(e){ return e.cuenta === c; });
      if(!movs.length) return;
      var saldo = movs.reduce(function(s,e){ return s + e.debe - e.haber; }, 0);
      movs.forEach(function(e){ fM.push([nombreCuenta(c), e.fecha, e.glosa, e.debe?e.debe.toFixed(2):'', e.haber?e.haber.toFixed(2):'', '']); });
      fM.push([nombreCuenta(c) + ' — SALDO', '', '', '', '', saldo.toFixed(2)]);
    });
    bloques.push(fM);

    var ventas = sumaCuenta(asientos, '70', 'haber');
    var gPersonal = sumaCuenta(asientos, '62', 'debe');
    var gServicios = sumaCuenta(asientos, '63', 'debe');
    var gOtros = sumaCuenta(asientos, '65', 'debe');
    var utilidad = ventas - gPersonal - gServicios - gOtros;
    bloques.push([
      ['— ESTADO DE RESULTADOS —'],
      ['Ventas de servicio', ventas.toFixed(2)],
      ['(-) Gastos de personal', gPersonal.toFixed(2)],
      ['(-) Gastos de servicios', gServicios.toFixed(2)],
      ['(-) Otros gastos', gOtros.toFixed(2)],
      ['Utilidad del periodo', utilidad.toFixed(2)]
    ]);

    var contenido = bloques.map(function(b){ return filasACSV(b); }).join('\r\n\r\n');
    var nombre = 'contabilidad_' + empresa.id + '_' + nombrePeriodoArchivo() + '.csv';
    var ok = descargarArchivo(nombre, contenido);
    if(window.fxToast) window.fxToast(ok ? 'Descargando ' + nombre : 'No se pudo generar el archivo', ok ? 'ok' : 'err');
  }
  var btnDescContab = document.getElementById('btnDescargarContab');
  if(btnDescContab) btnDescContab.addEventListener('click', exportarContabilidadCSV);

  document.getElementById('btnCopiarDiario').addEventListener('click', function(){
    var filas = [['Fecha','Glosa','Cuenta','Debe','Haber']];
    asientosDelPeriodo().forEach(function(e){
      filas.push([e.fecha, e.glosa, nombreCuenta(e.cuenta), e.debe ? e.debe.toFixed(2) : '', e.haber ? e.haber.toFixed(2) : '']);
    });
    copiarTsvADocumento(filas, 'btnCopiarDiario', 'diarioStatus');
  });

  document.getElementById('btnCopiarMayor').addEventListener('click', function(){
    var entradas = asientosDelPeriodo();
    var filas = [['Cuenta','Fecha','Glosa','Debe','Haber','Saldo de la cuenta']];
    Object.keys(CUENTAS).forEach(function(c){
      var movs = entradas.filter(function(e){ return e.cuenta === c; });
      if(movs.length === 0) return;
      var saldo = movs.reduce(function(s,e){ return s + e.debe - e.haber; }, 0);
      movs.forEach(function(e){
        filas.push([nombreCuenta(c), e.fecha, e.glosa, e.debe ? e.debe.toFixed(2) : '', e.haber ? e.haber.toFixed(2) : '', '']);
      });
      filas.push([nombreCuenta(c) + ' — SALDO', '', '', '', '', saldo.toFixed(2)]);
    });
    copiarTsvADocumento(filas, 'btnCopiarMayor', 'mayorStatus');
  });

  document.getElementById('btnCopiarResultados').addEventListener('click', function(){
    var entradas = asientosDelPeriodo();
    var ventas = sumaCuenta(entradas, '70', 'haber');
    var gPersonal = sumaCuenta(entradas, '62', 'debe');
    var gServicios = sumaCuenta(entradas, '63', 'debe');
    var gOtros = sumaCuenta(entradas, '65', 'debe');
    var totalGastos = gPersonal + gServicios + gOtros;
    var filas = [
      ['Estado de Resultados (simulado)', ''],
      ['Ventas — Servicio de transporte de agua', ventas.toFixed(2)],
      ['Gastos de personal', gPersonal.toFixed(2)],
      ['Gastos de servicios prestados por terceros', gServicios.toFixed(2)],
      ['Otros gastos de gestión', gOtros.toFixed(2)],
      ['Total gastos operativos', totalGastos.toFixed(2)],
      ['Utilidad operativa del periodo', (ventas - totalGastos).toFixed(2)]
    ];
    copiarTsvADocumento(filas, 'btnCopiarResultados', 'resultadosStatus');
  });

  document.getElementById('btnCopiarBalance').addEventListener('click', function(){
    var entradas = asientosTodos();
    var caja = sumaCuenta(entradas, '10', 'debe') - sumaCuenta(entradas, '10', 'haber');
    var ctasCobrar = sumaCuenta(entradas, '12', 'debe') - sumaCuenta(entradas, '12', 'haber');
    var ventas = sumaCuenta(entradas, '70', 'haber');
    var gastosTot = sumaCuenta(entradas, '62', 'debe') + sumaCuenta(entradas, '63', 'debe') + sumaCuenta(entradas, '65', 'debe');
    var utilidadAcumulada = ventas - gastosTot;
    var filas = [
      ['Balance General (simulado) al ' + HOY, ''],
      ['ACTIVO', ''],
      ['Caja y Bancos', caja.toFixed(2)],
      ['Cuentas por Cobrar Comerciales', ctasCobrar.toFixed(2)],
      ['Total Activo', (caja + ctasCobrar).toFixed(2)],
      ['PASIVO Y PATRIMONIO', ''],
      ['Capital Social (por definir)', (0).toFixed(2)],
      ['Resultados Acumulados', utilidadAcumulada.toFixed(2)],
      ['Total Patrimonio', utilidadAcumulada.toFixed(2)]
    ];
    copiarTsvADocumento(filas, 'btnCopiarBalance', 'balanceStatus');
  });

  document.getElementById('btnCopiarFlujo').addEventListener('click', function(){
    var entradas = asientosDelPeriodo();
    var ingresos = sumaCuenta(entradas, '10', 'debe');
    var egresosPersonal = sumaCuenta(entradas, '62', 'debe');
    var egresosServicios = sumaCuenta(entradas, '63', 'debe');
    var egresosOtros = sumaCuenta(entradas, '65', 'debe');
    var totalEgresos = egresosPersonal + egresosServicios + egresosOtros;
    var filas = [
      ['Flujo de Caja (simulado)', ''],
      ['Ingresos de efectivo', ingresos.toFixed(2)],
      ['Sueldos pagados', egresosPersonal.toFixed(2)],
      ['Servicios de terceros pagados', egresosServicios.toFixed(2)],
      ['Otros gastos pagados', egresosOtros.toFixed(2)],
      ['Total egresos de efectivo', totalEgresos.toFixed(2)],
      ['Flujo neto de caja del periodo', (ingresos - totalEgresos).toFixed(2)]
    ];
    copiarTsvADocumento(filas, 'btnCopiarFlujo', 'flujoStatus');
  });

  document.getElementById('btnCopiarEficiencia').addEventListener('click', function(){
    var medidos = pedidosConTiempoCompleto(pedidosDelPeriodo());
    var filas = [['Fecha','ID','Cliente','Chofer'].concat(ETAPAS, ['Total'])];
    medidos.forEach(function(p){
      var etapasCols = ETAPAS.map(function(_, idx){ return formatearDuracionMin(duracionEtapaPedido(p, idx)); });
      filas.push([p.fecha, p.id, p.cliente, p.chofer || ''].concat(etapasCols, [formatearDuracionMin(duracionTotalPedido(p))]));
    });
    filas.push(['']);
    filas.push(['Tiempo promedio por chofer']);
    filas.push(['Chofer','Viajes medidos','Tiempo promedio']);
    var porChofer = {};
    medidos.forEach(function(p){
      var nombre = p.chofer || 'Sin asignar';
      if(!porChofer[nombre]) porChofer[nombre] = { viajes: 0, totalMs: 0 };
      porChofer[nombre].viajes++;
      porChofer[nombre].totalMs += duracionTotalPedido(p);
    });
    Object.keys(porChofer).forEach(function(nombre){
      var st = porChofer[nombre];
      filas.push([nombre, st.viajes, formatearDuracionMin(st.totalMs / st.viajes)]);
    });
    copiarTsvADocumento(filas, 'btnCopiarEficiencia', 'eficienciaStatus');
  });

  /* ==========================================================================
     Supabase: sincronización remota en tiempo real de pedidos/gastos entre
     dispositivos. El cliente `supa` ya se creó al principio del script (se
     comparte con el login de más abajo). Esta sincronización solo arranca
     DESPUÉS de iniciar sesión (la llama cargarPerfilYEntrar(), en el bloque de
     Autenticación) porque las políticas RLS de pedidos/gastos ahora exigen un
     usuario autenticado — antes de eso, cualquier lectura sería rechazada.
     Si SUPABASE_URL/SUPABASE_ANON_KEY quedan vacíos, o el CDN no carga, o falla
     la conexión al proyecto, la app sigue funcionando con localStorage.
     ========================================================================== */

  var supaListo = false;           // true solo tras la primera sincronización exitosa
  var supaAplicandoRemoto = false; // true mientras se aplican datos que llegaron del servidor (evita reenviarlos de vuelta)
  var soportaUpdatedAt = false;    // ¿la BD tiene la columna updated_at? (feature-detect en iniciarSupabase)
  var supaDebounce = {};           // temporizadores para agrupar varios cambios de Realtime en un solo refresco

  function actualizarIndicadorSupabase(activo){
    var nota = document.getElementById('persistNote');
    if(!nota) return;
    nota.textContent = activo ? '🔗 Sincronizado con Supabase (todos los dispositivos)' : '💾 Guardado en este navegador';
    nota.title = activo ? 'Conectado a Supabase: los cambios se comparten en tiempo real.' : 'Sin conexión a Supabase: los datos quedan solo en este navegador.';
  }

  // ---- Conversión de forma: nuestros objetos en JS (camelCase) <-> filas de Postgres (snake_case) ----
  // Añade updated_at al payload SOLO si la BD tiene esa columna (feature-detect en
  // iniciarSupabase). Antes de correr la migración de supabase_schema.sql,
  // soportaUpdatedAt = false y el payload va como siempre (sin regresión).
  function conUpdatedAt(remoto, obj){
    if(soportaUpdatedAt) remoto.updated_at = (obj && obj.updatedAt) || new Date().toISOString();
    return remoto;
  }
  function pedidoARemoto(p){
    return conUpdatedAt({
      id: p.id, fecha: p.fecha, orden: p.orden || 0, cliente: p.cliente || '',
      codigo_cliente: p.codigoCliente || '', ubicacion: p.ubicacion || '',
      hora_inicio: p.horaInicio || '', hora_fin: p.horaFin || '', precio: Number(p.precio) || 0,
      chofer: p.chofer || '', ayudante: p.ayudante || '', tipo_almacen: p.tipoAlmacen || '',
      piso: p.piso != null ? String(p.piso) : '-', dificultad: p.dificultad || '', manguera: p.manguera || '',
      notas: p.notas || '', estado: p.estado || '', motivo_cancelacion: p.motivoCancelacion || '',
      tiempos: Array.isArray(p.tiempos) ? p.tiempos : tiemposVacios(),
      promotor_email: p.promotorEmail || '', telefono: p.telefono || '',
      empresa_id: p.empresaId || 'kunturmasha',
      // Number(...) || 0 en vez de "p.volumenM3 || null": un volumen de 0 (o un valor no
      // numérico) es válido y debe llegar como número, nunca como null — Supabase no debe
      // recibir null aquí (ver también solicitudARemoto(), que ya usaba este mismo patrón).
      volumen_m3: Number(p.volumenM3) || 0, metodo_pago: p.metodoPago || ''
    }, p);
  }
  function pedidoDesdeRemoto(r){
    return {
      id: r.id, fecha: r.fecha, orden: r.orden, cliente: r.cliente, codigoCliente: r.codigo_cliente,
      ubicacion: r.ubicacion, horaInicio: r.hora_inicio, horaFin: r.hora_fin, precio: r.precio,
      chofer: r.chofer, ayudante: r.ayudante, tipoAlmacen: r.tipo_almacen, piso: r.piso,
      dificultad: r.dificultad, manguera: r.manguera, notas: r.notas, estado: r.estado,
      motivoCancelacion: r.motivo_cancelacion, tiempos: r.tiempos, promotorEmail: r.promotor_email || '',
      telefono: r.telefono || '', empresaId: r.empresa_id || 'kunturmasha',
      volumenM3: r.volumen_m3 || 0, metodoPago: r.metodo_pago || '',
      updatedAt: r.updated_at || null
    };
  }
  function gastoARemoto(g){
    return conUpdatedAt({ id: g.id, fecha: g.fecha, categoria: g.categoria || '', descripcion: g.descripcion || '', monto: Number(g.monto) || 0, empresa_id: g.empresaId || 'kunturmasha' }, g);
  }
  function gastoDesdeRemoto(r){
    // sanText(): la fila puede haber sido escrita por cualquiera con la anon key (ver sanText).
    return { id: sanText(r.id, 80), fecha: r.fecha, categoria: sanText(r.categoria, 120), descripcion: sanText(r.descripcion, 400), monto: r.monto, empresaId: sanText(r.empresa_id, 80) || 'kunturmasha', updatedAt: r.updated_at || null };
  }

  // Combina lo que hay en este navegador con lo que hay en Supabase. Si un id
  // existe en ambos lados: gana la versión con `updatedAt` MÁS RECIENTE (así dos
  // dispositivos que editaron el mismo pedido no se pisan sin más — antes ganaba
  // siempre la remota). Si alguna de las dos no tiene `updatedAt` (fila vieja,
  // escrita por otra vía), se conserva el comportamiento anterior: gana la remota.
  // Los ids que solo están de un lado se conservan tal cual.
  var _conflictosUltimaFusion = 0;
  function fusionarPorId(locales, remotos){
    var mapa = {};
    locales.forEach(function(x){ mapa[x.id] = x; });
    _conflictosUltimaFusion = 0;
    remotos.forEach(function(rem){
      var loc = mapa[rem.id];
      if(!loc){ mapa[rem.id] = rem; return; }
      var tl = loc.updatedAt, tr = rem.updatedAt;
      if(tl && tr && tl !== tr){
        _conflictosUltimaFusion++;
        mapa[rem.id] = (tl > tr) ? loc : rem;   // ISO-8601: comparación de string = cronológica
      } else {
        mapa[rem.id] = rem;                      // sin sellos fiables -> gana la remota (como antes)
      }
    });
    if(_conflictosUltimaFusion) console.info('[sync] ' + _conflictosUltimaFusion + ' fila(s) en conflicto resueltas por fecha de edición');
    return Object.keys(mapa).map(function(id){ return mapa[id]; });
  }

  // Sube el estado local completo de una tabla a Supabase: inserta/actualiza (upsert) todas
  // las filas actuales y borra en el servidor las que ya no existen localmente (para que
  // eliminar o cancelar-e-importar-otra-copia se refleje igual del lado remoto).
  function reconciliarRemoto(tabla, filasLocales, mapaARemoto){
    if(!supa) return;
    supa.from(tabla).select('id').then(function(res){
      if(res.error){ console.warn('Supabase: no se pudo leer', tabla, res.error.message); return; }
      var idsRemotos = res.data.map(function(r){ return r.id; });
      var idsLocales = filasLocales.map(function(f){ return f.id; });
      var aEliminar = idsRemotos.filter(function(id){ return idsLocales.indexOf(id) === -1; });
      var tareas = [];
      if(aEliminar.length) tareas.push(supa.from(tabla).delete().in('id', aEliminar));
      if(filasLocales.length) tareas.push(supa.from(tabla).upsert(filasLocales.map(mapaARemoto), { onConflict: 'id' }));
      Promise.all(tareas).then(function(resultados){
        resultados.forEach(function(r){ if(r && r.error) console.warn('Supabase: error al sincronizar', tabla, r.error.message); });
      });
    }).catch(function(err){ console.warn('Supabase: fallo de red al sincronizar', tabla, err); });
  }

  // Aplica al estado local (memoria + localStorage + pantalla) filas que llegaron del
  // servidor, sin volver a reenviarlas (por eso el guardado va envuelto en el flag).
  // Envuelve una actualización que puede insertar/quitar tarjetas ANTES de las que ya
  // están a la vista (llega un pedido nuevo de otro dispositivo, por ejemplo): aunque
  // renderLista() ya solo toca en el DOM las tarjetas que cambiaron (ver más arriba),
  // insertar una tarjeta arriba de lo visible empuja todo lo de abajo — sin esto, lo que
  // el usuario está mirando "saltaría" en la pantalla aunque el scrollY no cambie. Se
  // ancla a la primera tarjeta visible, se mide su posición antes y después, y se corrige
  // el scroll por la diferencia, así el contenido queda clavado en el mismo lugar.
  function conScrollPreservado(fn){
    var tarjetas = els.timelineList ? els.timelineList.children : [];
    var anclaId = null, antes = 0;
    for(var i = 0; i < tarjetas.length; i++){
      var r = tarjetas[i].getBoundingClientRect();
      if(r.bottom > 0 && r.top < window.innerHeight){ anclaId = tarjetas[i].dataset.id; antes = r.top; break; }
    }
    fn();
    if(!anclaId) return;
    var nodo = Array.prototype.find.call(els.timelineList.children, function(n){ return n.dataset.id === anclaId; });
    if(!nodo) return;
    var despues = nodo.getBoundingClientRect().top;
    var delta = despues - antes;
    if(delta) window.scrollBy(0, delta);
  }

  function aplicarFilasRemotas(tabla, filas){
    // La causa más común de "parpadeo": este cliente sube un cambio, Supabase Realtime
    // le devuelve el eco de su propio cambio ~400ms después, y sin este chequeo se
    // reemplazaba toda la lista y se volvía a pintar todo (con sus animaciones de
    // entrada) para mostrar exactamente lo mismo que ya había en pantalla. Si el
    // contenido que llega es idéntico al que ya tenemos en memoria, no hay nada que
    // actualizar — se corta aquí, antes de tocar el estado o el DOM.
    if(tabla === 'pedidos'){
      var pedidosNuevos = migrarPedidos(filas.map(pedidoDesdeRemoto));
      if(firmaLista(pedidosNuevos) === firmaLista(pedidos)) return;
    } else if(tabla === 'gastos'){
      var gastosNuevos = filas.map(gastoDesdeRemoto);
      if(firmaLista(gastosNuevos) === firmaLista(gastos)) return;
    } else {
      return;
    }
    supaAplicandoRemoto = true;
    try{
      if(tabla === 'pedidos'){
        pedidos = pedidosNuevos;
        guardarPedidos();
      } else if(tabla === 'gastos'){
        gastos = gastosNuevos;
        guardarGastos();
      }
      conScrollPreservado(renderTodo);
    } finally {
      supaAplicandoRemoto = false;
    }
  }

  function refrescarDesdeSupabase(tabla){
    if(!supa) return;
    supa.from(tabla).select('*').then(function(res){
      if(res.error){ console.warn('Supabase: error al refrescar', tabla, res.error.message); return; }
      aplicarFilasRemotas(tabla, res.data || []);
    }).catch(function(err){ console.warn('Supabase: fallo de red al refrescar', tabla, err); });
  }
  function programarRefresco(tabla){
    clearTimeout(supaDebounce[tabla]);
    // Pequeño margen para agrupar varios cambios seguidos (ej. una reconciliación
    // que borra + sube varias filas) en un solo refresco en vez de uno por evento.
    supaDebounce[tabla] = setTimeout(function(){ refrescarDesdeSupabase(tabla); }, 400);
  }

  // ---- Reconexión de Realtime: el socket de Supabase ya reintenta solo a nivel de
  // WebSocket, pero un canal puede quedar en CHANNEL_ERROR/TIMED_OUT/CLOSED sin
  // resuscribirse automáticamente (ej. la laptop se suspende, cambia de wifi, hay un
  // corte breve). Esto vigila el estado del canal, se vuelve a suscribir con backoff,
  // y al recuperar la conexión trae el estado completo por si se perdieron eventos
  // mientras estuvo caído (Realtime no reenvía lo que pasó durante el corte). Nunca
  // lanza excepciones hacia afuera: en el peor caso la app se queda en lo último que
  // tenía en pantalla, nunca se rompe la UI.
  var canalRealtime = null;
  var intentosReconexionCanal = 0;
  var primeraSuscripcionCanal = true;

  function suscribirRealtime(){
    if(canalRealtime){ try{ supa.removeChannel(canalRealtime); }catch(e){} }
    canalRealtime = supa.channel('despacho-hidrico-cambios')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, function(){ programarRefresco('pedidos'); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos' }, function(){ programarRefresco('gastos'); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitudes_centrales' }, function(){ programarRefrescoHub(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ofertas_subasta' }, function(){ programarRefrescoHub(); })
      .subscribe(function(status){
        if(status === 'SUBSCRIBED'){
          intentosReconexionCanal = 0;
          actualizarIndicadorSupabase(true);
          if(!primeraSuscripcionCanal){
            // Reconexión tras un corte: refresca por si Realtime se perdió cambios.
            refrescarDesdeSupabase('pedidos');
            refrescarDesdeSupabase('gastos');
          }
          primeraSuscripcionCanal = false;
        } else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
          actualizarIndicadorSupabase(false); // honesto: mientras reintenta, no está sincronizado
          intentosReconexionCanal++;
          var espera = Math.min(30000, 2000 * intentosReconexionCanal); // backoff hasta 30s
          setTimeout(function(){ if(supa) suscribirRealtime(); }, espera);
        }
      });
  }

  var supaConectando = false;
  var supaReintentoMs = 5000;

  async function iniciarSupabase(){
    if(supaConectando || supaListo) return; // evita conexiones solapadas
    if(!supa) return; // sin credenciales o sin CDN disponible: se queda en modo local, sin avisos ni errores
    supaConectando = true;

    try{
      // ¿la BD ya tiene la columna updated_at (ver supabase_schema.sql)? Si NO, hay
      // que quitarla de los payloads o PostgREST rechaza el upsert entero (PGRST204).
      // Así el mismo código funciona antes y después de correr la migración.
      try{
        var probe = await supa.from('pedidos').select('updated_at').limit(1);
        soportaUpdatedAt = !probe.error;
      }catch(_){ soportaUpdatedAt = false; }

      var resPedidos = await supa.from('pedidos').select('*');
      if(resPedidos.error) throw resPedidos.error;
      var resGastos = await supa.from('gastos').select('*');
      if(resGastos.error) throw resGastos.error;

      var pedidosRemotos = (resPedidos.data || []).map(pedidoDesdeRemoto);
      var gastosRemotos = (resGastos.data || []).map(gastoDesdeRemoto);

      supaAplicandoRemoto = true;
      pedidos = migrarPedidos(fusionarPorId(pedidos, pedidosRemotos));
      gastos = fusionarPorId(gastos, gastosRemotos);
      guardarPedidos();
      guardarGastos();
      supaAplicandoRemoto = false;

      supaListo = true;
      supaReintentoMs = 5000; // reinicia el backoff para el próximo corte
      reconciliarRemoto('pedidos', pedidos, pedidoARemoto); // sube lo que solo existía en este navegador
      reconciliarRemoto('gastos', gastos, gastoARemoto);
      suscribirRealtime();
      actualizarIndicadorSupabase(true);
      renderTodo();
      cargarConfigEmpresasRemoto(); // best-effort: si la tabla config_empresas no existe todavía, no rompe nada de lo anterior
    }catch(err){
      console.warn('Supabase: no se pudo conectar; la app sigue funcionando en modo local.', err);
      // OJO: a propósito NO se pone `supa = null` aquí — ese mismo cliente lo sigue usando
      // el login (Autenticación) y el botón de cerrar sesión; un fallo pasajero al leer
      // pedidos/gastos (RLS, red) no debe tumbar la sesión activa, solo reintenta la sync.
      supaListo = false;
      supaAplicandoRemoto = false;
      actualizarIndicadorSupabase(false);
      // Reintento con backoff (hasta 60s) en vez de quedarse en modo local para
      // siempre: si el corte fue temporal (sin internet al cargar la página, DNS
      // lento, etc.), la app se reconecta sola sin que el usuario recargue.
      setTimeout(function(){ iniciarSupabase(); }, supaReintentoMs);
      supaReintentoMs = Math.min(supaReintentoMs * 1.7, 60000);
    }finally{
      supaConectando = false;
    }
  }

  // Cuando el navegador recupera la conexión: si nunca llegamos a conectar, reintenta
  // ya mismo (sin esperar el backoff); si ya estábamos conectados, fuerza un refresco
  // por si el WebSocket tardó en darse cuenta de que había vuelto la red.
  window.addEventListener('online', function(){
    if(!supaListo) iniciarSupabase();
    else { refrescarDesdeSupabase('pedidos'); refrescarDesdeSupabase('gastos'); }
  });

  /* ==========================================================================
     Hub Central + Subasta (marketplace multiempresa, rama "demo"). Dos tablas nuevas e
     independientes de pedidos/gastos (ver supabase_schema.sql): solicitudes_centrales
     (lo que publica un cliente) y ofertas_subasta (lo que oferta cada empresa). El cierre
     de una subasta NO depende de un cron en el servidor — se resuelve en el navegador de
     quien la esté mirando cuando el tiempo se cumple (resolverSubastasVencidas()); el
     update en Supabase lleva `.eq('estado','Abierta')` como guardia atómica, así que si dos
     personas la resuelven al mismo instante, solo la primera escritura cuenta y solo esa
     crea el pedido — la segunda no encuentra fila que actualizar y no hace nada más.
     ========================================================================== */
  var MIS_SOLICITUDES_KEY = 'kunturmasha_mis_solicitudes_v1';
  function cargarMisSolicitudes(){
    try{ var l = JSON.parse(localStorage.getItem(MIS_SOLICITUDES_KEY) || '[]'); return Array.isArray(l) ? l : []; }
    catch(e){ return []; }
  }
  var misSolicitudesIds = cargarMisSolicitudes();
  function guardarMisSolicitudes(){ try{ localStorage.setItem(MIS_SOLICITUDES_KEY, JSON.stringify(misSolicitudesIds)); }catch(e){} }

  // "Contacto habitual" — nombre y teléfono se recuerdan en este navegador para no tener
  // que retiparlos cada vez que se publica una solicitud nueva.
  var HUB_CONTACTO_KEY = 'kunturmasha_hub_contacto_v1';
  function cargarContactoHabitual(){
    try{ return JSON.parse(localStorage.getItem(HUB_CONTACTO_KEY) || 'null') || null; }catch(e){ return null; }
  }
  function guardarContactoHabitual(cliente, telefono){
    try{ localStorage.setItem(HUB_CONTACTO_KEY, JSON.stringify({ cliente: cliente, telefono: telefono })); }catch(e){}
  }

  var solicitudesCentrales = [];
  var ofertasSubasta = [];
  var hubDebounce = null;
  var hubTimerInterval = null;
  var VENTANA_SUBASTA_MIN = 30;

  function solicitudARemoto(s){
    return {
      id: s.id, cliente: s.cliente || '', telefono: s.telefono || '', volumen_m3: Number(s.volumenM3) || 0,
      ubicacion: s.ubicacion || '', tipo_descarga: s.tipoDescarga || '', hora_fin: s.horaFin, estado: s.estado || 'Abierta',
      empresa_ganadora_id: s.empresaGanadoraId || null, oferta_ganadora_precio: s.ofertaGanadoraPrecio || null,
      oferta_ganadora_tiempo: s.ofertaGanadoraTiempo || null, comision_sede_central: s.comisionSedeCentral || null,
      pedido_generado_id: s.pedidoGeneradoId || null,
      lat: (s.lat || s.lat === 0) ? s.lat : null, lng: (s.lng || s.lng === 0) ? s.lng : null,
      // manguera_metros es integer en la base (ver verificación end-to-end) — nunca se manda
      // el string del <select> tal cual ("10m", "50m+"): siempre convertido a número puro.
      manguera_metros: s.mangueraMetros ? parseInt(s.mangueraMetros, 10) : null, piso: s.piso || null
    };
  }
  function solicitudDesdeRemoto(r){
    // sanText() en todo texto libre: solicitudes_centrales es escribible con la anon key
    // pública y su contenido se pinta en la pizarra del Hub para todas las empresas.
    return {
      id: sanText(r.id, 80), cliente: sanText(r.cliente, 120), telefono: sanText(r.telefono, 40),
      volumenM3: r.volumen_m3, ubicacion: sanText(r.ubicacion, 300),
      tipoDescarga: sanText(r.tipo_descarga, 60), horaFin: r.hora_fin, estado: sanText(r.estado, 40),
      empresaGanadoraId: sanText(r.empresa_ganadora_id, 80),
      ofertaGanadoraPrecio: r.oferta_ganadora_precio, ofertaGanadoraTiempo: r.oferta_ganadora_tiempo,
      comisionSedeCentral: r.comision_sede_central, pedidoGeneradoId: sanText(r.pedido_generado_id, 80),
      lat: r.lat, lng: r.lng, mangueraMetros: sanText(r.manguera_metros, 40), piso: sanText(r.piso, 40)
    };
  }
  function ofertaARemoto(o){
    // empresa_nombre es NOT NULL en la tabla real (ver verificación end-to-end) — se manda
    // siempre derivado de buscarEmpresa(), nunca a mano, para que no se pueda desincronizar.
    return { id: o.id, solicitud_id: o.solicitudId, empresa_id: o.empresaId, empresa_nombre: buscarEmpresa(o.empresaId).nombre, precio: Number(o.precio) || 0, tiempo_entrega_min: Number(o.tiempoEntregaMin) || 0 };
  }
  function ofertaDesdeRemoto(r){
    // empresaNombre viene de la fila remota (escribible con la anon key) — sanText() antes
    // de que llegue a la pizarra de ofertas. El nombre de confianza se re-deriva de
    // buscarEmpresa() en ofertaARemoto() al subir, pero al LEER hay que sanear igual.
    return { id: sanText(r.id, 80), solicitudId: sanText(r.solicitud_id, 80), empresaId: sanText(r.empresa_id, 80), empresaNombre: sanText(r.empresa_nombre, 120), precio: r.precio, tiempoEntregaMin: r.tiempo_entrega_min };
  }

  function refrescarHub(){
    if(!supa) return;
    Promise.all([
      supa.from('solicitudes_centrales').select('*').order('created_at', { ascending: false }),
      supa.from('ofertas_subasta').select('*')
    ]).then(function(res){
      var rSol = res[0], rOf = res[1];
      if(rSol.error || rOf.error){
        console.warn('Hub Central: no se pudo leer (¿falta correr la sección "Marketplace" de supabase_schema.sql?)', (rSol.error || rOf.error).message);
        return;
      }
      solicitudesCentrales = rSol.data.map(solicitudDesdeRemoto);
      ofertasSubasta = rOf.data.map(ofertaDesdeRemoto);
      resolverSubastasVencidas();
      if(vistaActual === 'hub') renderHub();
    }).catch(function(err){ console.warn('Hub Central: fallo de red', err); });
  }
  function programarRefrescoHub(){
    clearTimeout(hubDebounce);
    hubDebounce = setTimeout(refrescarHub, 400);
  }

  // Menor precio gana; empate lo rompe el tiempo de entrega más rápido.
  function mejorOferta(solicitudId){
    var ofertas = ofertasSubasta.filter(function(o){ return o.solicitudId === solicitudId; });
    if(!ofertas.length) return null;
    return ofertas.slice().sort(function(a, b){
      if(a.precio !== b.precio) return a.precio - b.precio;
      return a.tiempoEntregaMin - b.tiempoEntregaMin;
    })[0];
  }

  function horaActualHHMM(d){
    d = d || new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Cierra y adjudica una solicitud vencida (o cerrada a mano, ver "Adjudicar ahora"): calcula
  // la mejor oferta, escribe el resultado en Supabase con guardia atómica (.eq('estado',
  // 'Abierta')) para que dos navegadores resolviendo al mismo tiempo no dupliquen el pedido,
  // retiene la comisión de peaje de Sede Central, y transfiere el viaje a la agenda interna
  // de la empresa ganadora (nuevo pedido con su empresaId, teléfono ya desbloqueado).
  // "ofertaElegida" es opcional: si el cliente presiona "Aceptar Oferta Ahora" en una
  // oferta puntual, se adjudica esa — sin esperar a que se cumplan los 30 min ni a que sea
  // la más barata. Si se omite (cierre automático por el temporizador), se calcula la
  // mejor con mejorOferta() como antes. La guardia .eq('estado','Abierta') decide cuál de
  // las dos vías gana si compiten (la que le gane la carrera a Supabase, ver comentario
  // más abajo) — nunca se duplica el pedido.
  async function adjudicarSolicitud(solicitud, ofertaElegida){
    if(!supa) return;
    var ganadora = ofertaElegida || mejorOferta(solicitud.id);
    if(!ganadora){
      await supa.from('solicitudes_centrales').update({ estado: 'Cerrada sin ofertas' }).eq('id', solicitud.id).eq('estado', 'Abierta');
      refrescarHub();
      return;
    }
    var empresaGanadora = buscarEmpresa(ganadora.empresaId);
    var comision = ganadora.precio * (empresaGanadora.comisionPeaje || 0);
    var nuevoPedidoId = siguienteId();
    var upd = await supa.from('solicitudes_centrales')
      .update({
        estado: 'Adjudicada', empresa_ganadora_id: empresaGanadora.id,
        oferta_ganadora_precio: ganadora.precio, oferta_ganadora_tiempo: ganadora.tiempoEntregaMin,
        comision_sede_central: comision, pedido_generado_id: nuevoPedidoId
      })
      .eq('id', solicitud.id).eq('estado', 'Abierta').select();
    if(!upd.data || !upd.data.length) { refrescarHub(); return; } // otro navegador ya la adjudicó primero

    var horaInicio = horaActualHHMM();
    var nuevoPedido = {
      id: nuevoPedidoId, fecha: isoHoy(), orden: siguienteOrden(isoHoy()),
      cliente: solicitud.cliente || ('Cliente Hub ' + solicitud.id), codigoCliente: obtenerCodigoParaCliente(solicitud.cliente || solicitud.id),
      telefono: solicitud.telefono || '', ubicacion: solicitud.ubicacion || '',
      horaInicio: horaInicio, horaFin: sumarMinutosHora(horaInicio, 120), precio: ganadora.precio,
      chofer: '', ayudante: '', tipoAlmacen: solicitud.tipoDescarga || '', piso: solicitud.piso || '-', dificultad: '',
      manguera: solicitud.mangueraMetros ? (solicitud.mangueraMetros >= 50 ? '50m+' : solicitud.mangueraMetros + 'm') : '',
      notas: 'Adjudicado por el Hub Central (subasta ' + solicitud.id + ', ' + solicitud.volumenM3 + ' m³) — tiempo de entrega ofertado: ' + ganadora.tiempoEntregaMin + ' min.',
      estado: 'Programado', motivoCancelacion: '', tiempos: tiemposVacios(), promotorEmail: '', empresaId: empresaGanadora.id
    };
    pedidos = migrarPedidos(pedidos.concat([nuevoPedido]));
    guardarPedidos();
    if(empresaGanadora.id === empresaActivaId) renderTodo();
    refrescarHub();
  }

  function resolverSubastasVencidas(){
    if(!supa) return;
    var ahora = Date.now();
    solicitudesCentrales
      .filter(function(s){ return s.estado === 'Abierta' && new Date(s.horaFin).getTime() <= ahora; })
      .forEach(function(s){ adjudicarSolicitud(s); });
  }

  function formatCuentaRegresiva(ms){
    var totalSeg = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(totalSeg / 60), s = totalSeg % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  // Actualiza solo el texto de las cuentas regresivas ya en pantalla (no repinta renderHub()
  // entero) — así no se pierde el foco de quien está escribiendo su oferta mientras el
  // segundero corre. Si alguna llega a 00:00, dispara la resolución (que sí repinta, una vez).
  function actualizarCuentasRegresivas(){
    var vencida = false;
    document.querySelectorAll('.cuenta-regresiva').forEach(function(el){
      var restante = new Date(el.dataset.fin).getTime() - Date.now();
      el.textContent = formatCuentaRegresiva(restante);
      if(restante <= 0) vencida = true;
    });
    if(vencida) resolverSubastasVencidas();
  }
  function iniciarTimerHub(){
    if(hubTimerInterval) return;
    hubTimerInterval = setInterval(function(){
      if(vistaActual !== 'hub'){ clearInterval(hubTimerInterval); hubTimerInterval = null; return; }
      actualizarCuentasRegresivas();
    }, 1000);
  }

  function tablaOfertas(solicitudId){
    var ofertas = ofertasSubasta.filter(function(o){ return o.solicitudId === solicitudId; })
      .slice().sort(function(a, b){ return a.precio - b.precio || a.tiempoEntregaMin - b.tiempoEntregaMin; });
    if(!ofertas.length) return '<p class="campo-nota" style="margin:6px 0 0;">Todavía sin ofertas.</p>';
    var filas = ofertas.map(function(o, i){
      return '<tr' + (i === 0 ? ' style="color:var(--good); font-weight:700;"' : '') + '><td>' + escapeHtml(buscarEmpresa(o.empresaId).nombre) + '</td><td class="num">' + formatMoneda(o.precio) + '</td><td class="num">' + o.tiempoEntregaMin + ' min</td></tr>';
    }).join('');
    return '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Empresa</th><th class="num">Precio</th><th class="num">Entrega</th></tr></thead><tbody>' + filas + '</tbody></table></div>';
  }

  // Igual que tablaOfertas(), pero para el cliente — cada fila trae su botón "Aceptar Oferta
  // Ahora": no hace falta esperar los 30 min, el cliente puede cerrar la subasta al toque
  // con la empresa que prefiera (ver adjudicarSolicitud(solicitud, ofertaElegida)).
  function tablaOfertasCliente(solicitudId){
    var ofertas = ofertasSubasta.filter(function(o){ return o.solicitudId === solicitudId; })
      .slice().sort(function(a, b){ return a.precio - b.precio || a.tiempoEntregaMin - b.tiempoEntregaMin; });
    if(!ofertas.length) return '<p class="campo-nota" style="margin:6px 0 0;">Todavía sin ofertas — las empresas asociadas están viendo tu solicitud.</p>';
    var filas = ofertas.map(function(o, i){
      return '<tr' + (i === 0 ? ' style="color:var(--good); font-weight:700;"' : '') + '>' +
        '<td>' + escapeHtml(buscarEmpresa(o.empresaId).nombre) + '</td><td class="num">' + formatMoneda(o.precio) + '</td><td class="num">' + o.tiempoEntregaMin + ' min</td>' +
        '<td><button type="button" class="btn btn-aceptar-oferta" data-solicitud="' + escapeHtml(solicitudId) + '" data-oferta="' + escapeHtml(o.id) + '" style="padding:6px 12px; font-size:0.72rem;">✅ Aceptar Oferta Ahora</button></td>' +
      '</tr>';
    }).join('');
    return '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Empresa</th><th class="num">Precio</th><th class="num">Entrega</th><th></th></tr></thead><tbody>' + filas + '</tbody></table></div>';
  }

  /* ---- Cascarón fijo vs. lista dinámica ----
     El bug de foco venía de repintar TODO #hubContenido (formulario incluido) en cada
     refresco disparado por Realtime/temporizador. Ahora el formulario de publicar (cliente)
     o el panel de cabecera (empresa) se arman UNA sola vez por sesión de rol/empresa —
     renderHub() no los vuelve a tocar salvo que cambie el rol o la empresa activa — y
     renderHubLista() es lo único que se repinta seguido, dentro de #hubListaWrap. Para la
     empresa, las ofertas ("tu precio"/"tiempo de entrega") sí viven dentro de esa lista
     (necesitan verse actualizadas en vivo); ahí se usa document.activeElement como guardia
     extra: si la persona está escribiendo justo ahí, ese repintado puntual se salta. */
  function shellHubCliente(){
    var contacto = cargarContactoHabitual();
    return '<div class="panel form-panel">' +
        '<h2>Publica tu solicitud de agua</h2>' +
        '<p class="campo-nota">Las empresas asociadas verán tu pedido y ofertarán precio y tiempo de entrega durante ' + VENTANA_SUBASTA_MIN + ' minutos — tu teléfono solo se comparte con la empresa que gane.</p>' +
        '<form id="hubClienteForm">' +
          '<div class="form-group"><label>Cliente / contacto</label><input type="text" id="hubCliente" autocomplete="name" enterkeyhint="next" value="' + escapeHtml(contacto ? contacto.cliente : '') + '" required></div>' +
          '<div class="form-group"><label>Teléfono / WhatsApp de contacto</label><input type="tel" id="hubTelefono" inputmode="tel" autocomplete="tel" enterkeyhint="next" value="' + escapeHtml(contacto ? contacto.telefono : '') + '" required></div>' +
          '<div class="form-row">' +
            '<div class="form-group"><label>Volumen (m³)</label><input type="number" id="hubVolumen" min="1" step="0.5" value="7" required inputmode="decimal"></div>' +
            '<div class="form-group"><label>Tipo de descarga</label><select id="hubTipoDescarga"><option value="Tanque Elevado">Tanque Elevado</option><option value="Cisterna Subterránea / Pozo">Cisterna Subt. / Pozo</option><option value="Bidones / Cilindros">Bidones / Cilindros</option></select></div>' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="form-group"><label>Metros de manguera necesarios</label><select id="hubManguera"><option value="10">10 m</option><option value="20">20 m</option><option value="30">30 m</option><option value="50">50 m o más</option></select></div>' +
            '<div class="form-group" id="hubGroupPiso" hidden><label>Piso / nivel de altura</label><select id="hubPiso"><option value="1er piso">1er piso</option><option value="2do piso">2do piso</option><option value="3er piso">3er piso</option><option value="4to piso o más">4to piso o más</option></select></div>' +
          '</div>' +
          '<div class="form-group"><label>Distrito</label><select id="hubUbicacion">' + DISTRITOS.map(function(d){ return '<option value="' + escapeHtml(d) + '">' + d + '</option>'; }).join('') + '</select></div>' +
          '<div class="form-group">' +
            '<label>Ubicación exacta — marca el punto en el mapa o arrastra el pin</label>' +
            '<div id="hubMapa" style="height:240px; border-radius:12px; overflow:hidden; margin-bottom:8px; border:1px solid var(--border);"></div>' +
            '<button type="button" class="btn-ghost" id="btnUbicacionActualHub" style="width:100%; margin-bottom:4px;">📍 Usar mi ubicación actual</button>' +
            '<input type="hidden" id="hubLat"><input type="hidden" id="hubLng">' +
          '</div>' +
          '<div class="form-group"><label>Dirección exacta / Referencia escrita</label><input type="text" id="hubDireccion" autocomplete="street-address" enterkeyhint="send" placeholder="Se autocompleta al marcar el mapa, o escríbela tú" required></div>' +
          '<button type="submit" class="btn" style="width:100%;">Publicar solicitud</button>' +
          '<p class="modal-status" id="hubClienteStatus"></p>' +
        '</form>' +
      '</div>' +
      '<div id="hubListaWrap"></div>';
  }
  function shellHubEmpresa(){
    var empresa = buscarEmpresa(empresaActivaId);
    return '<div class="panel"><h2>🏢 ' + escapeHtml(empresa.nombre) + ' — Sala de Subasta</h2>' +
        '<p class="campo-nota">Ofertas de precio y tiempo de entrega sobre las solicitudes abiertas del Hub Central. La mejor oferta (menor precio, luego menor tiempo) gana al cerrar la ventana de ' + VENTANA_SUBASTA_MIN + ' min.</p>' +
      '</div>' +
      '<div id="hubListaWrap"></div>';
  }
  // Único listener del <form> de publicar (+ mapa, geolocalización y el toggle de piso) —
  // se conecta solo cuando el cascarón de cliente se vuelve a montar (cambio de rol), nunca
  // en cada refresco de la lista — por eso el mapa no se reinicia mientras la persona escribe.
  function activarFormularioHubCliente(){
    document.getElementById('hubTipoDescarga').addEventListener('change', hubTogglePiso);
    hubTogglePiso();
    iniciarMapaHub();
    document.getElementById('btnUbicacionActualHub').addEventListener('click', function(){
      if(!navigator.geolocation){ alert('Tu navegador no soporta geolocalización.'); return; }
      navigator.geolocation.getCurrentPosition(function(pos){
        colocarMarcadorHub(pos.coords.latitude, pos.coords.longitude);
      }, function(){ alert('No se pudo obtener tu ubicación — revisa los permisos del navegador.'); });
    });

    document.getElementById('hubClienteForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var status = document.getElementById('hubClienteStatus');
      if(!supa){ status.textContent = 'Sin conexión — intenta más tarde.'; status.className = 'modal-status err'; return; }
      // Validación en cliente (UX + primer filtro). El servidor NO debe confiar en esto:
      // la anon key permite saltarse este formulario, así que las restricciones de verdad
      // van como CHECK/longitud en supabase_schema.sql. sanText() quita < > " ' etc.
      var cliente = sanText(document.getElementById('hubCliente').value, 80);
      var telefono = sanText(document.getElementById('hubTelefono').value, 20);
      var distrito = sanText(document.getElementById('hubUbicacion').value, 80);
      var direccion = sanText(document.getElementById('hubDireccion').value, 200);
      var volumen = parseFloat(document.getElementById('hubVolumen').value);
      var tipoDescarga = sanText(document.getElementById('hubTipoDescarga').value, 40);
      var mangueraMetros = sanText(document.getElementById('hubManguera').value, 20);
      function fallar(msg){ status.textContent = msg; status.className = 'modal-status err'; }
      if(cliente.length < 2) return fallar('Escribe un nombre de contacto (mínimo 2 caracteres).');
      if(!/^[0-9+\-()\s]{6,20}$/.test(telefono)) return fallar('El teléfono debe tener entre 6 y 20 dígitos (solo números, espacios y + - ( )).');
      if(!(volumen >= 0.5 && volumen <= 50)) return fallar('El volumen debe estar entre 0.5 y 50 m³.');
      if(direccion.length < 4 && distrito.length < 2) return fallar('Indica una dirección o referencia (mínimo 4 caracteres).');
      if(!distrito) return fallar('Elige un distrito.');
      var lat = document.getElementById('hubLat').value;
      var lng = document.getElementById('hubLng').value;
      var nueva = {
        id: 'SOL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
        cliente: cliente, telefono: telefono,
        volumenM3: volumen,
        ubicacion: direccion ? (direccion + ' — ' + distrito) : distrito,
        tipoDescarga: tipoDescarga,
        mangueraMetros: mangueraMetros,
        piso: tipoDescarga === 'Tanque Elevado' ? sanText(document.getElementById('hubPiso').value, 20) : '',
        lat: lat ? parseFloat(lat) : null, lng: lng ? parseFloat(lng) : null,
        horaFin: new Date(Date.now() + VENTANA_SUBASTA_MIN * 60000).toISOString(),
        estado: 'Abierta'
      };
      var res = await supa.from('solicitudes_centrales').insert(solicitudARemoto(nueva));
      if(res.error){ status.textContent = 'No se pudo publicar: ' + res.error.message; status.className = 'modal-status err'; return; }
      misSolicitudesIds.push(nueva.id);
      guardarMisSolicitudes();
      guardarContactoHabitual(cliente, telefono); // para autocompletar la próxima vez
      status.textContent = '¡Publicado! Las empresas ya pueden ofertar.';
      status.className = 'modal-status ok';
      refrescarHub();
    });
  }
  function hubTogglePiso(){
    document.getElementById('hubGroupPiso').hidden = document.getElementById('hubTipoDescarga').value !== 'Tanque Elevado';
  }

  /* ---- Mapa interactivo (Leaflet + OpenStreetMap), estilo InDrive ----
     Se inicializa una sola vez por montaje del cascarón de cliente (ver
     activarFormularioHubCliente) — nunca en un refresco de la lista, así que no se reinicia
     mientras la persona interactúa con el formulario. Si el CDN de Leaflet no cargó (sin
     internet, bloqueado), queda en null y el campo de dirección sigue funcionando a mano:
     no bloquea publicar la solicitud. */
  var TRUJILLO_CENTRO = [-8.1116, -79.0287];
  var hubMapaLeaflet = null, hubMarcadorLeaflet = null;
  // Rendimiento: si ya había un mapa vivo (no debería, pero por si algún camino nuevo llama
  // a esto sin pasar por destruirMapaHub() primero) lo destruye antes de crear uno — Leaflet
  // no libera solo sus listeners/tiles si se pisa la variable sin invocar .remove().
  function destruirMapaHub(){
    if(hubMapaLeaflet){ try{ hubMapaLeaflet.remove(); }catch(e){} }
    hubMapaLeaflet = null; hubMarcadorLeaflet = null;
    hubShellMontado = null; // fuerza a renderHub() a reconstruir el cascarón la próxima vez
  }
  function iniciarMapaHub(){
    if(hubMapaLeaflet){ try{ hubMapaLeaflet.remove(); }catch(e){} }
    hubMapaLeaflet = null; hubMarcadorLeaflet = null;
    if(typeof window.L === 'undefined' || !document.getElementById('hubMapa')) return;
    try{
      hubMapaLeaflet = L.map('hubMapa').setView(TRUJILLO_CENTRO, 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
        maxZoom: 19
      }).addTo(hubMapaLeaflet);
      hubMapaLeaflet.on('click', function(e){ colocarMarcadorHub(e.latlng.lat, e.latlng.lng); });
      // El contenedor pudo medir 0×0 si el navegador todavía no había pintado la pestaña —
      // fuerza a Leaflet a recalcular tamaño una vez que sí la tiene.
      setTimeout(function(){ if(hubMapaLeaflet) hubMapaLeaflet.invalidateSize(); }, 200);
    }catch(e){ console.warn('Hub Central: no se pudo iniciar el mapa', e); hubMapaLeaflet = null; }
  }
  function colocarMarcadorHub(lat, lng){
    if(!hubMapaLeaflet) return;
    if(hubMarcadorLeaflet) hubMapaLeaflet.removeLayer(hubMarcadorLeaflet);
    hubMarcadorLeaflet = L.marker([lat, lng], { draggable: true }).addTo(hubMapaLeaflet);
    hubMarcadorLeaflet.on('dragend', function(){
      var pos = hubMarcadorLeaflet.getLatLng();
      actualizarCoordenadasHub(pos.lat, pos.lng);
    });
    hubMapaLeaflet.setView([lat, lng], 16);
    actualizarCoordenadasHub(lat, lng);
  }
  function actualizarCoordenadasHub(lat, lng){
    var elLat = document.getElementById('hubLat'), elLng = document.getElementById('hubLng');
    if(elLat) elLat.value = lat.toFixed(6);
    if(elLng) elLng.value = lng.toFixed(6);
    geocodificarInversoHub(lat, lng);
  }
  // Autocompleta el campo de dirección a partir del pin (Nominatim, el geocodificador
  // gratuito de OpenStreetMap) — el campo sigue siendo editable a mano en cualquier momento,
  // y si esto falla (sin internet, límite de la API) simplemente no autocompleta nada.
  function geocodificarInversoHub(lat, lng){
    fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng)
      .then(function(r){ return r.json(); })
      .then(function(data){
        var campo = document.getElementById('hubDireccion');
        if(campo && data && data.display_name) campo.value = data.display_name;
      })
      .catch(function(){ /* sin geocodificación inversa: el campo queda para llenar a mano */ });
  }

  function listaHubCliente(){
    var propias = solicitudesCentrales.filter(function(s){ return misSolicitudesIds.indexOf(s.id) !== -1; });
    if(!propias.length) return '';
    var filasPropias = propias.map(function(s){
      var estadoHtml;
      // Mientras está Abierta, el cliente ve cada oferta con su botón "Aceptar Oferta
      // Ahora" — no hace falta esperar los 30 min (estilo InDrive); el temporizador solo
      // queda como límite máximo si nadie elige antes.
      var claseEstado = '';
      if(s.estado === 'Abierta'){
        estadoHtml = '<span class="hub-espera-badge">📡 En subasta</span> — cierra en <span class="cuenta-regresiva mono" data-fin="' + escapeHtml(s.horaFin) + '">' + formatCuentaRegresiva(new Date(s.horaFin).getTime() - Date.now()) + '</span><span class="hub-espera-hint">Buscando la mejor oferta entre las empresas de la red…</span>' + tablaOfertasCliente(s.id);
        claseEstado = ' hub-esperando';
      }
      else if(s.estado === 'Adjudicada'){
        estadoHtml = '✅ Adjudicado a <strong>' + escapeHtml(buscarEmpresa(s.empresaGanadoraId).nombre) + '</strong> — ' + formatMoneda(s.ofertaGanadoraPrecio) + ', entrega en ' + s.ofertaGanadoraTiempo + ' min. Te contactan al ' + escapeHtml(s.telefono || '');
        claseEstado = ' hub-adjudicado';
      }
      else estadoHtml = '✖️ Cerrada sin ofertas — intenta de nuevo o escríbenos por WhatsApp';
      return '<div class="panel' + claseEstado + '" style="margin-bottom:12px;"><div class="order-client">' + escapeHtml(s.ubicacion) + ' · ' + s.volumenM3 + ' m³ · ' + escapeHtml(s.tipoDescarga) + '</div><p class="campo-nota" style="margin:6px 0 0;">' + estadoHtml + '</p></div>';
    }).join('');
    return '<h3 style="font-size:0.9rem; margin:20px 0 10px;">Tus solicitudes</h3>' + filasPropias;
  }

  function listaHubEmpresa(){
    var empresa = buscarEmpresa(empresaActivaId);
    var abiertas = solicitudesCentrales.filter(function(s){ return s.estado === 'Abierta'; });
    var propias = solicitudesCentrales.filter(function(s){ return s.estado !== 'Abierta' && (s.empresaGanadoraId === empresa.id || ofertasSubasta.some(function(o){ return o.solicitudId === s.id && o.empresaId === empresa.id; })); });

    var tarjetasAbiertas = abiertas.map(function(s){
      var miOferta = ofertasSubasta.find(function(o){ return o.solicitudId === s.id && o.empresaId === empresa.id; });
      var restante = new Date(s.horaFin).getTime() - Date.now();
      var botonAdjudicar = empresa.esSedeCentral ?
        '<button type="button" class="btn-ghost btn-adjudicar-ahora" data-id="' + escapeHtml(s.id) + '" style="margin-top:8px; font-size:0.72rem; padding:6px 12px;">⏹ Cerrar y adjudicar ahora (Sede Central)</button>' : '';
      return '<div class="panel" style="margin-bottom:14px;">' +
          '<div class="order-head"><div class="order-time">📍 ' + escapeHtml(s.ubicacion) + '</div><div class="order-price mono">⏳ <span class="cuenta-regresiva" data-fin="' + escapeHtml(s.horaFin) + '">' + formatCuentaRegresiva(restante) + '</span></div></div>' +
          '<div class="order-meta"><span class="meta-tag">💧 ' + escapeHtml(String(s.volumenM3)) + ' m³</span><span class="meta-tag">' + escapeHtml(s.tipoDescarga) + '</span><span class="meta-tag">🔒 Teléfono oculto hasta ganar</span></div>' +
          tablaOfertas(s.id) +
          '<form class="oferta-form" data-solicitud="' + escapeHtml(s.id) + '" style="display:flex; gap:8px; flex-wrap:wrap; align-items:end; margin-top:10px;">' +
            '<div class="form-group" style="margin:0; flex:1 1 120px;"><label>Tu precio (S/.)</label><input type="number" class="oferta-precio" min="1" step="0.01" value="' + (miOferta ? miOferta.precio : '') + '" required></div>' +
            '<div class="form-group" style="margin:0; flex:1 1 220px;"><label>Tiempo estimado de llegada hasta la ubicación del cliente (minutos)</label><input type="number" class="oferta-tiempo" min="1" value="' + (miOferta ? miOferta.tiempoEntregaMin : '') + '" required></div>' +
            '<button type="submit" class="btn" style="padding:9px 16px;">' + (miOferta ? 'Actualizar oferta' : 'Ofertar') + '</button>' +
          '</form>' +
          botonAdjudicar +
        '</div>';
    }).join('') || '<div class="empty-state">Sin solicitudes abiertas por ahora.</div>';

    var filasHistorial = propias.slice(0, 15).map(function(s){
      var gane = s.empresaGanadoraId === empresa.id;
      var estado = s.estado === 'Adjudicada' ? (gane ? '🏆 Ganada' : 'Perdida') : 'Cerrada sin ofertas';
      var telefono = gane ? escapeHtml(s.telefono || '') : (s.estado === 'Adjudicada' ? '🔒' : '—');
      return '<tr><td>' + escapeHtml(s.ubicacion) + '</td><td class="num">' + s.volumenM3 + ' m³</td><td>' + estado + '</td><td class="num">' + (gane ? formatMoneda(s.ofertaGanadoraPrecio) : '—') + '</td><td>' + telefono + '</td></tr>';
    }).join('');

    var comisionSedeCentral = empresa.esSedeCentral ?
      ('<div class="panel" style="margin-top:16px;"><h2>Comisión de intermediación — 5% (Sede Central)</h2>' +
        '<p class="campo-nota" style="margin:0 0 12px;">Se retiene automáticamente el 5% del precio adjudicado en cada subasta ganada, sin importar qué empresa se la lleve.</p>' +
        '<div class="stats-strip">' + tileHtml({ label: 'Retenido en subastas adjudicadas (5%)', value: formatMoneda(solicitudesCentrales.filter(function(s){ return s.estado === 'Adjudicada'; }).reduce(function(sum, s){ return sum + (Number(s.comisionSedeCentral) || 0); }, 0)), cls: 'good' }) + '</div></div>') : '';

    return tarjetasAbiertas +
      '<div class="panel" style="margin-top:16px;"><h2>Historial de subastas de tu empresa</h2>' +
        (filasHistorial ? '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Ubicación</th><th class="num">Volumen</th><th>Resultado</th><th class="num">Precio</th><th>Teléfono</th></tr></thead><tbody>' + filasHistorial + '</tbody></table></div>' : '<div class="empty-state">Todavía no participaste en ninguna subasta.</div>') +
      '</div>' + comisionSedeCentral;
  }

  // Listeners de la LISTA (ofertar / adjudicar ahora) — se re-conectan cada vez que
  // #hubListaWrap se repinta, porque innerHTML destruye los nodos y sus listeners viejos.
  function activarListenersLista(){
    document.querySelectorAll('.oferta-form').forEach(function(form){
      form.addEventListener('submit', async function(e){
        e.preventDefault();
        if(!supa) return;
        var solicitudId = form.dataset.solicitud;
        var precio = parseFloat(form.querySelector('.oferta-precio').value);
        var tiempo = parseInt(form.querySelector('.oferta-tiempo').value, 10);
        // Rangos sanos — el servidor los repite como CHECK (ver supabase_schema.sql).
        if(!(precio >= 1 && precio <= 100000)){ alert('El precio de la oferta debe estar entre S/. 1 y S/. 100 000.'); return; }
        if(!(tiempo >= 1 && tiempo <= 1440)){ alert('El tiempo de entrega debe estar entre 1 y 1440 minutos.'); return; }
        if(!solicitudesCentrales.some(function(x){ return x.id === solicitudId && x.estado === 'Abierta'; })){ alert('Esa solicitud ya no está abierta.'); return; }
        var existente = ofertasSubasta.find(function(o){ return o.solicitudId === solicitudId && o.empresaId === empresaActivaId; });
        var oferta = { id: existente ? existente.id : ('OFE-' + Date.now().toString(36).toUpperCase()), solicitudId: solicitudId, empresaId: empresaActivaId, precio: precio, tiempoEntregaMin: tiempo };
        await supa.from('ofertas_subasta').upsert(ofertaARemoto(oferta), { onConflict: 'solicitud_id,empresa_id' });
        refrescarHub();
      });
    });

    document.querySelectorAll('.btn-adjudicar-ahora').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = solicitudesCentrales.find(function(x){ return x.id === btn.dataset.id; });
        if(s && confirm('¿Cerrar la subasta ahora mismo con las ofertas actuales?')) adjudicarSolicitud(s);
      });
    });

    // "Aceptar Oferta Ahora" (cliente) — adjudica esa oferta puntual al instante, sin
    // esperar los 30 min ni que sea la más barata (ver adjudicarSolicitud(solicitud, oferta)).
    document.querySelectorAll('.btn-aceptar-oferta').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = solicitudesCentrales.find(function(x){ return x.id === btn.dataset.solicitud; });
        var o = ofertasSubasta.find(function(x){ return x.id === btn.dataset.oferta; });
        if(!s || !o) return;
        if(confirm('¿Aceptar la oferta de ' + buscarEmpresa(o.empresaId).nombre + ' por ' + formatMoneda(o.precio) + '? Le compartimos tu contacto de inmediato para coordinar la entrega.')){
          adjudicarSolicitud(s, o);
        }
      });
    });
  }

  // true si algún refresco se saltó el repintado de la lista porque había foco activo ahí
  // (ver renderHubLista) — al soltar el foco (focusout, más abajo) se repinta con lo último.
  var hubListaPendiente = false;

  function renderHubLista(){
    var wrap = document.getElementById('hubListaWrap');
    if(!wrap) return; // el cascarón todavía no se montó (ej. sin conexión a Supabase)
    if(rolActivo === 'admin'){
      if(wrap.contains(document.activeElement)){ hubListaPendiente = true; return; }
      hubListaPendiente = false;
      wrap.innerHTML = listaHubEmpresa();
    } else {
      wrap.innerHTML = listaHubCliente();
    }
    activarListenersLista();
  }
  // Apenas se suelta el foco dentro del Hub, si quedó un repintado pendiente (ver arriba),
  // se aplica — con un margen chico para no dispararlo por un simple Tab entre dos campos
  // del mismo formulario de oferta.
  document.getElementById('hubContenido').addEventListener('focusout', function(){
    setTimeout(function(){
      var wrap = document.getElementById('hubListaWrap');
      if(hubListaPendiente && wrap && !wrap.contains(document.activeElement)) renderHubLista();
    }, 150);
  });

  // Qué cascarón está montado ahora mismo ('cliente' | 'admin:<empresaId>' | null) — solo
  // se reconstruye el cascarón (y por lo tanto el <form>) si esto cambia; un refresco de
  // datos normal (Realtime, temporizador) nunca lo toca.
  var hubShellMontado = null;
  function renderHub(){
    var cont = document.getElementById('hubContenido');
    if(!supa){
      cont.innerHTML = '<div class="panel"><div class="empty-state">El Hub Central necesita conexión a Supabase.</div></div>';
      hubShellMontado = null;
      return;
    }
    var clave = rolActivo === 'admin' ? ('admin:' + empresaActivaId) : 'cliente';
    if(hubShellMontado !== clave){
      cont.innerHTML = clave === 'cliente' ? shellHubCliente() : shellHubEmpresa();
      hubShellMontado = clave;
      if(clave === 'cliente') activarFormularioHubCliente();
    }
    renderHubLista();
    iniciarTimerHub();
    // Si el mapa ya existía (el cascarón no se reconstruyó) y la pestaña estuvo oculta,
    // Leaflet puede haber medido el contenedor en 0×0 — recalcula tamaño por si acaso.
    if(hubMapaLeaflet) hubMapaLeaflet.invalidateSize();
    if(!solicitudesCentrales.length && !ofertasSubasta.length) refrescarHub(); // primera carga
  }

  /* ==========================================================================
     Autenticación del personal — SIN Supabase Auth. El correo/contraseña se
     valida en el navegador contra CREDENCIALES_PERSONAL (definida más arriba).
     Los clientes no pasan por nada de esto: entran directo con rolActivo =
     'cliente'. La sincronización de pedidos/gastos con Supabase (iniciarSupabase,
     más abajo en iniciarApp()) arranca siempre, haya o no sesión de personal —
     las políticas RLS de pedidos/gastos ya no exigen auth.uid() (ver
     supabase_schema.sql, sección "acceso abierto").
     ========================================================================== */
  var MAPA_ROL_DB_A_INTERNO = { Administrador: 'admin', Chofer: 'chofer', Promotor: 'promotor', Cliente: 'cliente', Ayudante: 'ayudante' };
  var ROL_PILL_CLASE = { Administrador: 'rol-admin', Chofer: 'rol-chofer', Promotor: 'rol-promotor', Cliente: 'rol-cliente', Ayudante: 'rol-ayudante' };
  // Inverso de MAPA_ROL_DB_A_INTERNO — para mostrar la etiqueta/pill correcta cuando el rol
  // activo cambia por el selector rápido de rol (cambiarRolActivo()), sin volver a loguearse.
  var INTERNO_A_ROL_DB = { admin: 'Administrador', chofer: 'Chofer', promotor: 'Promotor', cliente: 'Cliente', ayudante: 'Ayudante' };
  var ETIQUETA_ROL_INTERNO = { admin: '👔 Administrador', chofer: '🚚 Chofer', promotor: '🤝 Promotor comisionista', ayudante: '🧰 Ayudante', cliente: '👤 Cliente' };
  // Roles que una credencial puede usar sin volver a loguearse (multi-rol dinámico, ver
  // cambiarRolActivo() y actualizarSelectorRol()). Si una cuenta no trae "roles", se
  // comporta igual que siempre: un único rol fijo, el de cred.rol.
  function rolesDeCredencial(cred){
    if(cred && Array.isArray(cred.roles) && cred.roles.length) return cred.roles;
    return cred ? [MAPA_ROL_DB_A_INTERNO[cred.rol] || 'cliente'] : ['cliente'];
  }
  var usuarioActual = null;   // { email, nombre } de la credencial que inició sesión, o null si nadie del personal entró
  var rolDbActual = null;     // 'Administrador' | 'Chofer' | 'Promotor' | null (sin sesión de personal)

  function actualizarSesionUI(){
    var logueado = !!usuarioActual;
    var credPropia = logueado ? buscarCredencial(usuarioActual.email) : null;
    document.getElementById('sessionChip').hidden = !logueado;
    document.getElementById('btnAccesoPersonal').hidden = logueado;
    document.getElementById('sessionEmail').textContent = logueado ? nombreMostrado(credPropia) : '';
    if(logueado) document.getElementById('sessionEmail').title = usuarioActual.email;
    var pill = document.getElementById('sessionRolPill');
    pill.textContent = rolDbActual || '';
    pill.className = 'rol-pill ' + (ROL_PILL_CLASE[rolDbActual] || '');
    var ceEmail = document.getElementById('ajustesCuentaEmail');
    if(ceEmail) ceEmail.textContent = logueado ? usuarioActual.email : '— (cliente, sin cuenta) —';
    var ceRol = document.getElementById('ajustesCuentaRol');
    if(ceRol){
      ceRol.textContent = rolDbActual || 'Cliente';
      ceRol.className = 'rol-pill ' + (ROL_PILL_CLASE[rolDbActual || 'Cliente'] || '');
    }
    actualizarBotonCambiarModo(credPropia);
    actualizarSelectorRol(credPropia);
  }

  // Botón "Cambiar a modo X" — visible solo si la cuenta con sesión iniciada tiene una
  // "parejaEmail" (hoy, Piero: admin1 <-> chofer1). Alterna al instante entre sus dos
  // cuentas sin pedir contraseña de nuevo, porque ya se demostró quién es al iniciar sesión
  // con cualquiera de las dos.
  function actualizarBotonCambiarModo(cred){
    var btn = document.getElementById('btnCambiarModo');
    var pareja = cred && cred.parejaEmail ? buscarCredencial(cred.parejaEmail) : null;
    btn.hidden = !pareja;
    if(pareja) btn.textContent = '🔄 Cambiar a modo ' + pareja.rol;
  }
  document.getElementById('btnCambiarModo').addEventListener('click', function(){
    var credPropia = usuarioActual ? buscarCredencial(usuarioActual.email) : null;
    var pareja = credPropia && credPropia.parejaEmail ? buscarCredencial(credPropia.parejaEmail) : null;
    if(!pareja) return;
    guardarSesionPersonal(pareja);
    entrarComoPersonal(pareja);
  });

  // Multi-rol dinámico (nuevo): selector rápido de rol para cuentas con más de un rol
  // autorizado (cred.roles — hoy solo Piero, SuperAdmin) — cambia rolActivo al instante,
  // sin cerrar sesión ni volver a pedir contraseña. Distinto del botón "Cambiar a modo X" de
  // arriba, que alterna entre DOS CUENTAS de una misma persona; esto alterna entre los ROLES
  // de UNA SOLA cuenta. Si la cuenta solo tiene un rol posible, el selector queda oculto.
  var rolSwitcherEl = document.getElementById('rolSwitcher');
  function actualizarSelectorRol(cred){
    var roles = cred ? rolesDeCredencial(cred) : [];
    if(roles.length < 2){ rolSwitcherEl.hidden = true; rolSwitcherEl.innerHTML = ''; return; }
    rolSwitcherEl.innerHTML = roles.map(function(r){ return '<option value="' + r + '">' + (ETIQUETA_ROL_INTERNO[r] || r) + '</option>'; }).join('');
    rolSwitcherEl.value = rolActivo;
    rolSwitcherEl.hidden = false;
  }
  rolSwitcherEl.addEventListener('change', function(){ cambiarRolActivo(this.value); });
  function cambiarRolActivo(interno){
    if(!VISTAS_POR_ROL[interno]) return;
    rolDbActual = INTERNO_A_ROL_DB[interno] || rolDbActual;
    aplicarRol(interno);
    actualizarSesionUI();
    actualizarSelectorEmpresa(); // el switch de empresa solo es visible/editable en modo Administrador
    irAVista(VISTAS_POR_ROL[interno].defaultView);
  }

  // Caducidad de la sesión de personal guardada. NO es una defensa contra forja
  // deliberada (el login es 100% de cliente: quien edite localStorage a mano entra
  // igual — eso solo se cierra migrando a Supabase Auth, ver INFORME-AUDITORIA-2.md).
  // Sí acota la ventana de una sesión olvidada en un equipo compartido / robada de
  // un backup viejo de localStorage.
  var SESION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h
  function cargarSesionPersonal(){
    try{
      var raw = localStorage.getItem(SESION_PERSONAL_KEY);
      if(!raw) return null;
      var s = JSON.parse(raw);
      // Formato viejo (solo {email}, sin ts): se acepta una vez y se reescribe con ts.
      if(s && s.email && typeof s.ts !== 'number'){
        var credLegacy = buscarCredencial(s.email);
        if(credLegacy){ guardarSesionPersonal(credLegacy); return credLegacy; }
        return null;
      }
      if(!s || !s.email || (Date.now() - s.ts) > SESION_TTL_MS){
        borrarSesionPersonalGuardada();
        return null;
      }
      // Revalida contra CREDENCIALES_PERSONAL (no confía ciegamente en lo guardado): si la
      // cuenta ya no existe o le cambiaron el rol en el código, no se restaura la sesión.
      var cred = buscarCredencial(s.email);
      return cred || null;
    }catch(e){ return null; }
  }
  function guardarSesionPersonal(cred){
    try{ localStorage.setItem(SESION_PERSONAL_KEY, JSON.stringify({ email: cred.email, ts: Date.now() })); }catch(e){}
  }
  function borrarSesionPersonalGuardada(){
    try{ localStorage.removeItem(SESION_PERSONAL_KEY); }catch(e){}
  }

  // Entra como la cuenta de personal ya validada (login exitoso o sesión restaurada al
  // arrancar) — común a ambos casos, así que vive en una sola función.
  function entrarComoPersonal(cred){
    usuarioActual = { email: cred.email, nombre: cred.nombre };
    rolDbActual = cred.rol;
    var interno = MAPA_ROL_DB_A_INTERNO[rolDbActual] || 'cliente';
    aplicarRol(interno);
    // Después de fijar rolActivo (aplicarRol) — así el selector rápido de rol y el switch de
    // empresa quedan pintados con el rol/empresa correctos desde el primer render, no con los
    // de la sesión anterior (ver actualizarSelectorRol()/actualizarSelectorEmpresa()).
    actualizarSesionUI();
    actualizarSelectorEmpresa();
    aplicarTinteSegunContexto(true);
    irAVista(VISTAS_POR_ROL[interno].defaultView);
    // Ver la misma lógica en cancelarEdicion(): si quien entra es un promotor, su propia
    // persona ya aparece elegida en "Conseguido por" desde el primer vistazo al formulario.
    if(interno === 'promotor'){
      var personaCred = personaDeCredencial(cred);
      if(personaCred) els.conseguidoPor.value = personaCred.id;
    }
  }

  function cerrarSesionPersonal(){
    usuarioActual = null;
    rolDbActual = null;
    borrarSesionPersonalGuardada();
    actualizarSesionUI();
    actualizarSelectorEmpresa();
    aplicarRol('cliente');
    aplicarTinteSegunContexto(true);
    irAVista(VISTAS_POR_ROL.cliente.defaultView);
  }

  function limpiarMensajesAuth(){
    document.getElementById('authError').hidden = true;
    document.getElementById('authInfo').hidden = true;
  }
  function mostrarErrorAuth(msg){
    document.getElementById('authInfo').hidden = true;
    var el = document.getElementById('authError');
    el.textContent = msg;
    el.hidden = false;
  }

  function abrirLoginPersonal(){
    limpiarMensajesAuth();
    document.getElementById('loginPersonalForm').reset();
    document.getElementById('authOverlay').hidden = false;
    document.getElementById('loginEmail').focus();
  }
  function cerrarLoginPersonal(){
    document.getElementById('authOverlay').hidden = true;
  }

  document.getElementById('btnAccesoPersonal').addEventListener('click', abrirLoginPersonal);
  document.getElementById('btnCloseAuthOverlay').addEventListener('click', cerrarLoginPersonal);
  document.getElementById('authOverlay').addEventListener('click', function(e){
    if(e.target === document.getElementById('authOverlay')) cerrarLoginPersonal();
  });

  document.getElementById('loginPersonalForm').addEventListener('submit', function(e){
    e.preventDefault();
    limpiarMensajesAuth();
    var email = document.getElementById('loginEmail').value;
    var password = document.getElementById('loginPassword').value;
    var cred = buscarCredencial(email);
    if(!cred || cred.password !== password){
      mostrarErrorAuth('Correo o contraseña incorrectos.');
      return;
    }
    guardarSesionPersonal(cred);
    entrarComoPersonal(cred);
    cerrarLoginPersonal();
  });

  document.getElementById('btnLogout').addEventListener('click', cerrarSesionPersonal);

  /* ---------- Vista del rol "Ayudante": checklist de descarga + incidencias ----------
     El checklist (manguera conectada / descarga completada) es solo de este navegador —
     no hay columna en Supabase para eso todavía, así que vive en su propia llave de
     localStorage, independiente de "pedidos". La incidencia SÍ se guarda en el pedido
     (pedidos[].notas, vía guardarPedidos()) para que la vea también quien mire Ver
     agenda/Despacho, incluso desde otro dispositivo. */
  var AYUDANTE_CHECKLIST_KEY = 'kunturmasha_ayudante_checklist_v1';
  function cargarChecklistAyudante(){
    try{ var obj = JSON.parse(localStorage.getItem(AYUDANTE_CHECKLIST_KEY) || '{}'); return (obj && typeof obj === 'object') ? obj : {}; }
    catch(e){ return {}; }
  }
  var checklistAyudante = cargarChecklistAyudante();
  function guardarChecklistAyudante(){
    try{ localStorage.setItem(AYUDANTE_CHECKLIST_KEY, JSON.stringify(checklistAyudante)); }catch(e){}
  }
  function renderAyudante(){
    var cont = document.getElementById('ayudanteLista');
    if(!cont) return;
    var delDia = pedidos.filter(function(p){
      return p.fecha === fechaSeleccionada && (p.empresaId || 'kunturmasha') === empresaActivaId && esAbierto(p);
    });
    if(!delDia.length){
      cont.innerHTML = '<div class="panel"><div class="empty-state">Sin viajes en curso hoy para tu empresa.</div></div>';
      return;
    }
    cont.innerHTML = delDia.map(function(p){
      var chk = checklistAyudante[p.id] || {};
      return '<div class="panel" style="margin-bottom:12px;">' +
          '<div class="order-head"><div class="order-time">📍 ' + escapeHtml(p.ubicacion || p.cliente || p.id) + '</div><div class="order-price mono">' + escapeHtml(p.horaInicio || '') + '</div></div>' +
          '<div class="order-meta">' +
            (p.tipoAlmacen ? '<span class="meta-tag">' + escapeHtml(p.tipoAlmacen) + '</span>' : '') +
            (p.manguera ? '<span class="meta-tag">🧵 ' + escapeHtml(p.manguera) + '</span>' : '') +
            (p.piso && p.piso !== '-' ? '<span class="meta-tag">🏢 ' + escapeHtml(p.piso) + '</span>' : '') +
          '</div>' +
          '<label style="display:flex; gap:8px; align-items:center; margin-top:10px;"><input type="checkbox" class="chk-manguera" data-id="' + escapeHtml(p.id) + '"' + (chk.manguera ? ' checked' : '') + '> Manguera conectada</label>' +
          '<label style="display:flex; gap:8px; align-items:center; margin-top:6px;"><input type="checkbox" class="chk-descarga" data-id="' + escapeHtml(p.id) + '"' + (chk.descarga ? ' checked' : '') + '> Descarga completada</label>' +
          '<div class="form-group" style="margin-top:10px;"><label>Reportar incidencia en obra</label>' +
            '<textarea class="incidencia-texto" data-id="' + escapeHtml(p.id) + '" rows="2" placeholder="Ej: Fuga en la conexión, acceso bloqueado..."></textarea>' +
            '<button type="button" class="btn-ghost btn-reportar-incidencia" data-id="' + escapeHtml(p.id) + '" style="margin-top:6px;">🚨 Reportar incidencia</button>' +
          '</div>' +
          (p.notas ? '<p class="campo-nota" style="margin-top:8px;">📝 ' + escapeHtml(p.notas) + '</p>' : '') +
        '</div>';
    }).join('');
  }
  // Delegación de eventos sobre el contenedor (se repinta con innerHTML en cada renderAyudante,
  // así que atar los listeners una sola vez aquí evita duplicarlos en cada refresco).
  document.getElementById('ayudanteLista').addEventListener('change', function(e){
    var chkM = e.target.closest('.chk-manguera');
    var chkD = e.target.closest('.chk-descarga');
    var campo = chkM ? chkM : chkD;
    if(!campo) return;
    var id = campo.dataset.id;
    checklistAyudante[id] = checklistAyudante[id] || {};
    checklistAyudante[id][chkM ? 'manguera' : 'descarga'] = campo.checked;
    guardarChecklistAyudante();
  });
  document.getElementById('ayudanteLista').addEventListener('click', function(e){
    var btn = e.target.closest('.btn-reportar-incidencia');
    if(!btn) return;
    var id = btn.dataset.id;
    var textarea = document.querySelector('.incidencia-texto[data-id="' + CSS.escape(id) + '"]');
    var texto = textarea ? textarea.value.trim() : '';
    if(!texto) return;
    var p = pedidos.find(function(x){ return x.id === id; });
    if(!p) return;
    var marca = '[Incidencia — Ayudante, ' + new Date().toLocaleString('es-PE') + '] ' + texto;
    p.notas = p.notas ? (p.notas + ' | ' + marca) : marca;
    guardarPedidos();
    renderAyudante();
  });

  /* ---------- Ajustes: cuenta propia + lista fija de personal ---------- */
  // La lista de cuentas del personal (correo + contraseña) ya no se muestra en el perfil de
  // administradores normales — cada empresa solo administra la suya, no ve las credenciales
  // de las demás. Únicamente piero@watercorespace.pe (cuenta maestra) ve aquí el "Directorio
  // Central de Accesos" con las 150 cuentas generadas (ver generarDirectorioCentral()).
  var PIERO_SUPERADMIN_EMAIL = 'piero@watercorespace.pe';
  // "Eliminar mi cuenta" (Ajustes) — visible para cualquier personal con sesión.
  // Hoy no hay cuenta en el servidor (el login es de cliente, ver INFORME-AUDITORIA);
  // lo que se puede hacer es limpiar ESTE dispositivo y cerrar sesión. El borrado
  // formal se pide por la web (eliminar-cuenta.html) hasta que exista Supabase Auth
  // + la Edge Function eliminar-cuenta (ver supabase/functions/eliminar-cuenta/).
  function renderEliminarCuenta(){
    var box = document.getElementById('ajustesEliminarWrap');
    if(!box) return;
    box.hidden = !usuarioActual;
    if(!usuarioActual || box.dataset.montado === '1') return;
    box.dataset.montado = '1';
    var chk = document.getElementById('ajustesEliminarConfirmar');
    var btn = document.getElementById('btnEliminarCuenta');
    var st = document.getElementById('ajustesEliminarStatus');
    chk.addEventListener('change', function(){ btn.disabled = !chk.checked; });
    btn.addEventListener('click', function(){
      if(!chk.checked) return;
      if(!confirm('¿Borrar de este dispositivo tus datos de acceso y preferencias, y cerrar sesión?')) return;
      var conservar = { 'sedeCentral_pedidos_v1':1, 'sedeCentral_gastos_v1':1 }; // datos de negocio: no se tocan
      try{
        Object.keys(localStorage).forEach(function(k){
          if(!conservar[k] && (k.indexOf('kunturmasha') === 0 || k.indexOf('sedeCentral_') === 0)) localStorage.removeItem(k);
        });
      }catch(e){}
      st.textContent = 'Datos de este dispositivo borrados. Cerrando sesión…';
      st.className = 'modal-status ok';
      setTimeout(function(){ try{ cerrarSesionPersonal(); }catch(e){} location.replace('/'); }, 900);
    });
  }

  function renderAjustes(){
    renderEliminarCuenta();
    var wrap = document.getElementById('ajustesPersonalWrap');
    if(!wrap) return;
    // El panel "Personal de la empresa" lo ve cualquier Administrador (para SU empresa);
    // el Directorio Central de Accesos, solo la cuenta maestra. Otros roles no ven nada.
    var esAdmin = rolDbActual === 'Administrador';
    var esPiero = !!(usuarioActual && usuarioActual.email === PIERO_SUPERADMIN_EMAIL);
    if(!esAdmin){ wrap.innerHTML = ''; wrap.dataset.montado = ''; return; }
    // Reconstruye el cascarón si nunca se montó o si cambió quién lo mira (el Directorio
    // Central solo debe existir en el DOM cuando lo ve la cuenta maestra).
    var esSede = buscarEmpresa(empresaActivaId).esSedeCentral;
    var ctx = (esPiero ? '1' : '0') + (esSede ? 'S' : 'A');
    if(wrap.dataset.montado !== '1' || wrap.dataset.dc !== ctx){
      wrap.innerHTML =
        '<div id="pePanelHost"></div>' +
        (esSede ? '' : '<div id="colorPanelHost"></div>') +
        (esPiero ? '<div id="dcHost"></div>' : '');
      wrap.dataset.montado = '1';
      wrap.dataset.dc = ctx;
      if(esPiero) montarDirectorioCentral(document.getElementById('dcHost'));
    }
    // El panel de personal y el de color se reconstruyen en cada entrada a Ajustes y en cada
    // cambio de empresa (su estado es "vivo"). Sus inputs son efímeros y no hay repintados en
    // segundo plano que puedan pisar lo que se esté tecleando.
    var host = document.getElementById('pePanelHost');
    if(host){ host.innerHTML = panelPersonalEmpresaHtml(); activarPanelPersonalEmpresa(); }
    var colorHost = document.getElementById('colorPanelHost');
    if(colorHost){ colorHost.innerHTML = panelColorEmpresaHtml(); activarPanelColorEmpresa(); }
    if(esPiero) renderDirectorioCentralFiltrado();
  }

  // ---- Directorio Central de Accesos — se construye una sola vez (así no se pierde el
  // foco del buscador en cada tecla); renderDirectorioCentralFiltrado() repinta solo la tabla.
  function montarDirectorioCentral(cont){
    if(!cont) return;
    var opcionesEmpresa = EMPRESAS.filter(function(e){ return !e.esSedeCentral; })
      .map(function(e){ return '<option value="' + e.id + '">' + escapeHtml(e.nombre) + '</option>'; }).join('');
    cont.innerHTML =
      '<div class="panel" style="margin-top:16px;">' +
        '<h2>🔐 Directorio Central de Accesos</h2>' +
        '<p style="font-size:0.8rem; color:var(--muted); margin:0 0 12px;">150 cuentas de prueba (Administrador, Chofer y Ayudante — 10 de cada una) repartidas en las 5 empresas asociadas. Visible solo para esta cuenta maestra: son el pool de correos que cada empresa puede confirmar como personal.</p>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>Buscar (nombre o correo)</label><input type="search" id="dcBuscar" placeholder="Ej: garcia, ruta.norte, tanque..."></div>' +
          '<div class="form-group"><label>Empresa</label><select id="dcEmpresa"><option value="">Todas las empresas</option>' + opcionesEmpresa + '</select></div>' +
          '<div class="form-group"><label>Rol</label><select id="dcRol"><option value="">Todos los roles</option><option value="Administrador">Administrador</option><option value="Chofer">Chofer</option><option value="Ayudante">Ayudante</option></select></div>' +
        '</div>' +
        '<p class="campo-nota" id="dcContador"></p>' +
        '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Nombre</th><th>Empresa</th><th>Rol</th><th>Correo</th><th>Contraseña</th><th></th></tr></thead><tbody id="dcTbody"></tbody></table></div>' +
      '</div>';
    document.getElementById('dcBuscar').addEventListener('input', debounce(renderDirectorioCentralFiltrado, 150));
    document.getElementById('dcEmpresa').addEventListener('change', renderDirectorioCentralFiltrado);
    document.getElementById('dcRol').addEventListener('change', renderDirectorioCentralFiltrado);
    document.getElementById('dcTbody').addEventListener('click', function(e){
      var btn = e.target.closest('.btn-copiar-credencial');
      if(!btn) return;
      var texto = btn.dataset.email + ' / ' + btn.dataset.password;
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(texto).then(function(){
          var original = btn.textContent;
          btn.textContent = '✅ Copiado';
          setTimeout(function(){ btn.textContent = original; }, 1200);
        }).catch(function(){ alert('No se pudo copiar automáticamente. Credenciales: ' + texto); });
      } else {
        alert('Credenciales: ' + texto);
      }
    });
  }

  // ---- Panel "Personal de la empresa" — el Administrador confirma quién trabaja en su
  // empresa. Apunta SIEMPRE a la empresa activa (empresaActivaId): un Administrador normal
  // está fijo en la suya; Piero elige cuál con el switch 🏢 de la cabecera.
  // Dos modos de alta:
  //   • MANUAL (hoy solo Pozo Cangrejo Loco, ver PLANTILLA_ALTA_MANUAL): el Administrador
  //     escribe correo, contraseña, nombre y roles a mano — no hay pool que elegir.
  //   • POOL (el resto): elige un correo de la lista ya generada, o escribe uno nuevo. ----
  var PLANTILLA_ALTA_MANUAL = { 'pozo-cangrejo-loco': true };
  function esAltaManual(empresaId){ return !!PLANTILLA_ALTA_MANUAL[empresaId]; }
  function panelPersonalEmpresaHtml(){
    var empresa = buscarEmpresa(empresaActivaId);
    var manual = esAltaManual(empresa.id);
    var roster = rosterDeEmpresa(empresa.id);
    var colspan = manual ? 5 : 4;
    var filas = roster.map(function(m){
      var chips = m.roles.map(function(r){
        return '<span class="rol-pill ' + (ROL_PILL_CLASE[PLR_INT_A_DB[r]] || '') + '">' + escapeHtml(PLR_ETIQUETA[r] || r) + '</span>';
      }).join(' ');
      var passCol = manual ? '<td class="mono">' + escapeHtml((m.cred && m.cred.password) || '—') + '</td>' : '';
      return '<tr>' +
        '<td>' + escapeHtml(m.nombre) + '</td>' +
        '<td class="mono">' + escapeHtml(m.email) + '</td>' +
        passCol +
        '<td>' + (chips || '<span style="color:var(--muted);">—</span>') + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button type="button" class="btn-ghost btn-pe-editar" data-email="' + escapeHtml(m.email) + '" style="font-size:0.68rem; padding:4px 8px;">✏️ Editar</button> ' +
          '<button type="button" class="btn-ghost btn-pe-quitar" data-email="' + escapeHtml(m.email) + '" style="font-size:0.68rem; padding:4px 8px;">🗑️ Quitar</button>' +
        '</td></tr>';
    }).join('') || ('<tr><td colspan="' + colspan + '" style="text-align:center; color:var(--muted);">Sin personal confirmado todavía — agrega a alguien abajo para que aparezca en Despacho, Agenda, Contabilidad y billeteras.</td></tr>');
    var checksRoles = PLR_ROLES.map(function(r){
      return '<label style="display:inline-flex; align-items:center; gap:6px; margin:0 14px 6px 0; cursor:pointer;"><input type="checkbox" class="pe-rol" value="' + r + '"> ' + escapeHtml(PLR_ETIQUETA[r]) + '</label>';
    }).join('');
    var dominio = (empresa.id + '.pe').replace(/-/g, '');
    var camposIdentidad;
    if(manual){
      camposIdentidad =
        '<div class="form-row">' +
          '<div class="form-group"><label>Correo</label><input type="email" id="peCorreo" placeholder="nombre@' + escapeHtml(dominio) + '" autocomplete="off"></div>' +
          '<div class="form-group"><label>Contraseña</label><input type="text" id="pePassword" placeholder="Contraseña de acceso" autocomplete="off"></div>' +
          '<div class="form-group"><label>Nombre del trabajador</label><input type="text" id="peNombre" placeholder="Ej: Juan Pérez"></div>' +
        '</div>';
    } else {
      var enRoster = {};
      roster.forEach(function(m){ enRoster[m.email] = true; });
      var opcionesPool = poolCorreosDe(empresa.id).filter(function(o){ return !enRoster[o.email]; }).map(function(o){
        return '<option value="' + escapeHtml(o.email) + '">' + escapeHtml(o.email) + ' — ' + escapeHtml(o.rol) + (o.directorio ? ' (directorio)' : '') + '</option>';
      }).join('');
      camposIdentidad =
        '<div class="form-row">' +
          '<div class="form-group"><label>Correo</label><select id="peCorreoSelect"><option value="">— Elige un correo del pool —</option>' + opcionesPool + '<option value="__nuevo__">✍️ Escribir un correo nuevo…</option></select></div>' +
          '<div class="form-group" id="peCorreoNuevoWrap" hidden><label>Correo nuevo</label><input type="email" id="peCorreoNuevo" placeholder="nombre@' + escapeHtml(dominio) + '"></div>' +
          '<div class="form-group"><label>Nombre del trabajador</label><input type="text" id="peNombre" placeholder="Ej: Juan Pérez"></div>' +
        '</div>';
    }
    var thPass = manual ? '<th>Contraseña</th>' : '';
    var nota = manual
      ? 'Escribe a mano el correo, la contraseña, el nombre y los roles de cada trabajador. Solo el personal que confirmes aquí aparece en Despacho, "Conseguido por / Promotor", Contabilidad y billeteras.'
      : 'Solo el personal que confirmes aquí aparece en el selector de Chofer del Despacho, en "Conseguido por / Promotor", en las tablas de Contabilidad y en las billeteras. Los correos sin confirmar siguen en el pool para agregarlos cuando quieras.';
    return '<div class="panel" style="margin-bottom:16px;">' +
      '<h2>👥 Personal de la empresa — ' + escapeHtml(empresa.nombre) + '</h2>' +
      '<p class="campo-nota" style="margin:0 0 12px;">' + nota + '</p>' +
      '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Nombre</th><th>Correo</th>' + thPass + '<th>Roles</th><th></th></tr></thead><tbody id="peTbody">' + filas + '</tbody></table></div>' +
      '<form id="formPersonalEmpresa" style="margin-top:16px; border-top:1px solid var(--border); padding-top:14px;">' +
        '<h3 style="font-size:0.9rem; margin:0 0 10px;" id="peFormTitulo">Agregar personal</h3>' +
        '<input type="hidden" id="peEditando" value="">' +
        camposIdentidad +
        '<div class="form-group"><label>Roles autorizados</label><div style="margin-top:6px; display:flex; flex-wrap:wrap;">' + checksRoles + '</div>' +
          '<p class="campo-nota" style="margin:4px 0 0;">Con dos o más roles, esta persona podrá alternar entre ellos desde el selector de rol de la cabecera, sin volver a iniciar sesión.</p>' +
        '</div>' +
        '<button type="submit" class="btn">Confirmar personal</button> ' +
        '<button type="button" class="btn-ghost" id="peCancelar" hidden>Cancelar edición</button>' +
        '<p class="modal-status" id="pePersonalStatus"></p>' +
      '</form>' +
    '</div>';
  }
  function activarPanelPersonalEmpresa(){
    var form = document.getElementById('formPersonalEmpresa');
    if(!form) return;
    var manual = esAltaManual(empresaActivaId);
    var sel = document.getElementById('peCorreoSelect');
    var nuevoWrap = document.getElementById('peCorreoNuevoWrap');
    if(sel && nuevoWrap) sel.addEventListener('change', function(){ nuevoWrap.hidden = sel.value !== '__nuevo__'; });
    document.getElementById('peTbody').addEventListener('click', function(e){
      var bE = e.target.closest('.btn-pe-editar');
      var bQ = e.target.closest('.btn-pe-quitar');
      if(bE) cargarPersonalEnForm(bE.dataset.email);
      else if(bQ) quitarPersonalEmpresa(bQ.dataset.email);
    });
    document.getElementById('peCancelar').addEventListener('click', resetFormPersonal);
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var status = document.getElementById('pePersonalStatus');
      var editando = document.getElementById('peEditando').value;
      var roster = plantillaEmpresas[empresaActivaId] || {};
      var correo, password;
      if(manual){
        var campoCorreo = document.getElementById('peCorreo');
        correo = editando ? editando : normalizarCorreo(campoCorreo ? campoCorreo.value : '');
        var campoPass = document.getElementById('pePassword');
        password = (campoPass ? campoPass.value : '').trim();
        if(editando && !password) password = (roster[editando] && roster[editando].password) || '';
      } else {
        correo = editando
          ? editando
          : (sel && sel.value === '__nuevo__' ? normalizarCorreo(document.getElementById('peCorreoNuevo').value) : (sel ? sel.value : ''));
      }
      var nombre = document.getElementById('peNombre').value.trim();
      var roles = PLR_ROLES.filter(function(r){ return !!document.querySelector('.pe-rol[value="' + r + '"]:checked'); });
      if(!correo || correo.indexOf('@') === -1){ status.textContent = 'Escribe un correo válido.'; status.className = 'modal-status err'; return; }
      if(manual && !password){ status.textContent = 'Ponle una contraseña de acceso.'; status.className = 'modal-status err'; return; }
      if(!nombre){ status.textContent = 'Ponle el nombre del trabajador.'; status.className = 'modal-status err'; return; }
      if(!roles.length){ status.textContent = 'Marca al menos un rol.'; status.className = 'modal-status err'; return; }
      plantillaEmpresas[empresaActivaId] = plantillaEmpresas[empresaActivaId] || {};
      var entry = { nombre: nombre, roles: roles };
      if(manual) entry.password = password;
      plantillaEmpresas[empresaActivaId][correo] = entry;
      guardarPlantillaEmpresas();
      aplicarPlantillaACredenciales();
      var msg = '✅ ' + nombre + ' ' + (editando ? 'actualizado' : 'confirmado') + ' en ' + buscarEmpresa(empresaActivaId).nombre + '.';
      sincronizarPlantillaUI();
      var s2 = document.getElementById('pePersonalStatus');
      if(s2){ s2.textContent = msg; s2.className = 'modal-status ok'; }
    });
  }
  function cargarPersonalEnForm(email){
    var entry = (plantillaEmpresas[empresaActivaId] || {})[email];
    if(!entry) return;
    document.getElementById('peEditando').value = email;
    var campoCorreo = document.getElementById('peCorreo');
    if(campoCorreo){ campoCorreo.value = email; campoCorreo.disabled = true; }
    var campoPass = document.getElementById('pePassword');
    if(campoPass) campoPass.value = entry.password || '';
    var sel = document.getElementById('peCorreoSelect');
    if(sel) sel.disabled = true;
    var nuevoWrap = document.getElementById('peCorreoNuevoWrap');
    if(nuevoWrap) nuevoWrap.hidden = true;
    document.getElementById('peNombre').value = entry.nombre || '';
    document.querySelectorAll('.pe-rol').forEach(function(c){ c.checked = (entry.roles || []).indexOf(c.value) !== -1; });
    document.getElementById('peFormTitulo').textContent = 'Editar: ' + email;
    document.getElementById('peCancelar').hidden = false;
    document.getElementById('peNombre').focus();
  }
  function resetFormPersonal(){
    var f = document.getElementById('formPersonalEmpresa');
    if(!f) return;
    f.reset();
    document.getElementById('peEditando').value = '';
    var campoCorreo = document.getElementById('peCorreo');
    if(campoCorreo) campoCorreo.disabled = false;
    var sel = document.getElementById('peCorreoSelect');
    if(sel) sel.disabled = false;
    var nuevoWrap = document.getElementById('peCorreoNuevoWrap');
    if(nuevoWrap) nuevoWrap.hidden = true;
    document.getElementById('peFormTitulo').textContent = 'Agregar personal';
    document.getElementById('peCancelar').hidden = true;
  }
  function quitarPersonalEmpresa(email){
    var roster = plantillaEmpresas[empresaActivaId] || {};
    if(!roster[email]) return;
    if(!confirm('¿Quitar a ' + (roster[email].nombre || email) + ' del personal de ' + buscarEmpresa(empresaActivaId).nombre + '?\n\nSus registros pasados no se borran, pero dejará de aparecer en Despacho, Agenda, Contabilidad y billeteras. Puedes volver a darlo de alta cuando quieras.')) return;
    delete roster[email];
    guardarPlantillaEmpresas();
    var cred = buscarCredencial(email);
    if(cred){
      cred.enPlantilla = false;
      if(cred.personalPlantilla){
        var i = CREDENCIALES_PERSONAL.indexOf(cred);
        if(i >= 0) CREDENCIALES_PERSONAL.splice(i, 1);
      } else {
        cred.roles = [PLR_DB_A_INT[cred.rol] || 'admin'];
      }
    }
    sincronizarPlantillaUI();
  }
  // Refresca todo lo que depende de la plantilla tras un alta/edición/baja de personal.
  function sincronizarPlantillaUI(){
    poblarSelectChofer();
    poblarSelectPromotor();
    if(vistaActual === 'ajustes') renderAjustes();
    if(vistaActual === 'perfil') renderPerfil();
    if(vistaActual === 'contabilidad') renderContabilidad();
    renderLista();
  }

  // ---- Panel "🎨 Color de la empresa" (Ajustes) — rueda HSV: el ángulo es el tono (hue,
  // continuo → millones de matices) y el radio la intensidad (saturación). Solo cambia
  // --tint-h / --tint-s; toda la piel se rederiva desde el CSS. Se guarda por empresa
  // (tinteEmpresas) y se aplica cuando su personal tiene sesión en ese espacio. ----
  function panelColorEmpresaHtml(){
    var empresa = buscarEmpresa(empresaActivaId);
    var t = tinteDeEmpresa(empresa.id);
    return '<div class="panel" style="margin-bottom:16px;">' +
      '<h2>🎨 Color de la empresa — ' + escapeHtml(empresa.nombre) + '</h2>' +
      '<p class="campo-nota" style="margin:0 0 14px;">Arrastra el punto por la rueda para elegir el tono de tu espacio: hacia afuera = más intenso, hacia el centro = más pastel. Se aplica a todos tus paneles, botones y acentos manteniendo la armonía. Los clientes y la web general siguen en el celeste por defecto.</p>' +
      '<div class="color-panel-grid">' +
        '<div class="rueda-color" id="ruedaColor"><div class="rueda-thumb" id="ruedaThumb"></div></div>' +
        '<div class="color-side">' +
          '<div class="color-swatch-row"><span class="color-swatch" id="colorSwatch"></span><span class="mono" id="colorValor" style="font-size:0.78rem; color:var(--muted);"></span></div>' +
          '<div class="color-sat-row"><label>Intensidad</label><input type="range" id="colorSat" min="18" max="92" value="' + Math.round(t.s) + '"></div>' +
          '<button type="button" class="btn-ghost" id="colorReset">↺ Volver al celeste por defecto</button>' +
          '<p class="modal-status ok" id="colorStatus" style="min-height:1em;"></p>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function activarPanelColorEmpresa(){
    var rueda = document.getElementById('ruedaColor');
    if(!rueda) return;
    var thumb = document.getElementById('ruedaThumb');
    var swatch = document.getElementById('colorSwatch');
    var valor = document.getElementById('colorValor');
    var sat = document.getElementById('colorSat');
    var empresa = buscarEmpresa(empresaActivaId);
    var estado = tinteDeEmpresa(empresa.id); // { h, s } — copia mutable local
    function pintar(){
      var rect = rueda.getBoundingClientRect();
      var R = rect.width / 2;
      var rad = estado.h * Math.PI / 180;
      var dist = Math.min(1, estado.s / 100) * (R - 12);
      thumb.style.left = (R + dist * Math.sin(rad)) + 'px';
      thumb.style.top = (R - dist * Math.cos(rad)) + 'px';
      var css = 'hsl(' + estado.h + ' ' + estado.s + '% 45%)';
      thumb.style.background = css;
      if(swatch) swatch.style.background = css;
      if(valor) valor.textContent = 'Tono ' + Math.round(estado.h) + '°  ·  Intensidad ' + Math.round(estado.s) + '%';
    }
    function desdeEvento(e){
      var rect = rueda.getBoundingClientRect();
      var R = rect.width / 2;
      var x = (e.clientX - rect.left) - R;
      var y = (e.clientY - rect.top) - R;
      var ang = Math.atan2(x, -y) * 180 / Math.PI;
      if(ang < 0) ang += 360;
      estado.h = Math.round(ang * 10) / 10;
      estado.s = Math.max(18, Math.min(92, Math.round(Math.sqrt(x * x + y * y) / (R - 12) * 100)));
      if(sat) sat.value = estado.s;
      aplicarTinte(estado);
      pintar();
    }
    function guardar(){
      tinteEmpresas[empresa.id] = { h: estado.h, s: estado.s };
      guardarTinteEmpresas();
      var st = document.getElementById('colorStatus');
      if(st) st.textContent = '✅ Color guardado para ' + empresa.nombre + '.';
    }
    var arrastrando = false;
    rueda.addEventListener('pointerdown', function(e){ arrastrando = true; try{ rueda.setPointerCapture(e.pointerId); }catch(x){} desdeEvento(e); });
    rueda.addEventListener('pointermove', function(e){ if(arrastrando) desdeEvento(e); });
    rueda.addEventListener('pointerup', function(){ if(arrastrando){ arrastrando = false; guardar(); } });
    rueda.addEventListener('pointercancel', function(){ arrastrando = false; });
    if(sat){
      sat.addEventListener('input', function(){ estado.s = Number(sat.value); aplicarTinte(estado); pintar(); });
      sat.addEventListener('change', guardar);
    }
    var reset = document.getElementById('colorReset');
    if(reset) reset.addEventListener('click', function(){
      delete tinteEmpresas[empresa.id];
      guardarTinteEmpresas();
      estado.h = TINTE_DEFECTO.h; estado.s = TINTE_DEFECTO.s;
      if(sat) sat.value = estado.s;
      aplicarTinte(estado);
      pintar();
      var st = document.getElementById('colorStatus');
      if(st) st.textContent = '↺ Restablecido al celeste por defecto.';
    });
    requestAnimationFrame(pintar); // la rueda ya tiene tamaño en el DOM
  }
  // Repinta solo la tabla de resultados del Directorio Central según los filtros activos —
  // separado de renderAjustes() para no reconstruir los controles (y perder el foco de
  // búsqueda) en cada tecla.
  function renderDirectorioCentralFiltrado(){
    var tbody = document.getElementById('dcTbody');
    if(!tbody) return;
    var termino = (document.getElementById('dcBuscar').value || '').trim().toLowerCase();
    var empresaFiltro = document.getElementById('dcEmpresa').value;
    var rolFiltro = document.getElementById('dcRol').value;
    var filas = CREDENCIALES_PERSONAL.filter(function(c){
      if(!c.directorioCentral) return false;
      if(empresaFiltro && c.empresaId !== empresaFiltro) return false;
      if(rolFiltro && c.rol !== rolFiltro) return false;
      if(termino && c.email.toLowerCase().indexOf(termino) === -1 && c.nombre.toLowerCase().indexOf(termino) === -1) return false;
      return true;
    });
    document.getElementById('dcContador').textContent = filas.length + ' de 150 cuentas.';
    tbody.innerHTML = filas.map(function(c){
      return '<tr>' +
          '<td>' + escapeHtml(c.nombre) + '</td>' +
          '<td>' + escapeHtml(buscarEmpresa(c.empresaId).nombre) + '</td>' +
          '<td><span class="rol-pill ' + (ROL_PILL_CLASE[c.rol] || '') + '">' + escapeHtml(c.rol) + '</span></td>' +
          '<td class="mono">' + escapeHtml(c.email) + '</td>' +
          '<td class="mono">' + escapeHtml(c.password) + '</td>' +
          '<td><button type="button" class="btn-ghost btn-copiar-credencial" data-email="' + escapeHtml(c.email) + '" data-password="' + escapeHtml(c.password) + '" style="font-size:0.68rem; padding:4px 8px;">📋 Copiar</button></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="6" style="text-align:center; color:var(--muted);">Sin resultados para este filtro.</td></tr>';
  }

  /* ---------- Cotizar (público, sin sesión) ----------
     Además de la tarjeta de contacto (WhatsApp / llamada), lleva una CALCULADORA DE
     FLETES POR CUADRANTES: estima el flete según la zona de Trujillo, el volumen y el
     tipo de descarga. Es orientativa — no crea ningún pedido, solo arma un mensaje de
     WhatsApp con el detalle. Todos los precios son constantes ajustables aquí. */
  var FLETE_BASE = 90;                    // salida de cisterna (S/.)
  var FLETE_POR_M3 = 12;                  // S/. por m³
  var FLETE_RECARGO_TANQUE_ELEVADO = 25;  // descarga a tanque elevado
  var FLETE_CUADRANTES = {
    'Víctor Larco':  { recargo: 0,  etiqueta: 'Víctor Larco (cercano)' },
    'Luz del Sol':   { recargo: 45, etiqueta: 'Luz del Sol' },
    'El Milagro':    { recargo: 35, etiqueta: 'El Milagro / Huanchaco' },
    'Alto Trujillo': { recargo: 55, etiqueta: 'Alto Trujillo (El Porvenir alto)' },
    'Otro':          { recargo: 20, etiqueta: 'Trujillo Cercado y alrededores' }
  };
  function redondearA5(n){ return Math.round(n / 5) * 5; }
  function calcularFlete(cuadrante, volumenM3, descarga){
    var q = FLETE_CUADRANTES[cuadrante] || FLETE_CUADRANTES['Otro'];
    var vol = Math.max(1, Math.min(30, Number(volumenM3) || 0));
    var subM3 = vol * FLETE_POR_M3;
    var recTanque = descarga === 'tanque' ? FLETE_RECARGO_TANQUE_ELEVADO : 0;
    var total = redondearA5(FLETE_BASE + subM3 + q.recargo + recTanque);
    return {
      cuadrante: q.etiqueta, volumen: vol, base: FLETE_BASE, subM3: subM3,
      recargoZona: q.recargo, recargoTanque: recTanque, total: total
    };
  }
  (function initCalculadoraFlete(){
    var form = document.getElementById('fleteForm');
    if(!form) return;
    var elQ = document.getElementById('fleteCuadrante');
    var elV = document.getElementById('fleteVolumen');
    var elD = document.getElementById('fleteDescarga');
    var elOut = document.getElementById('fleteResultado');
    var elWa = document.getElementById('fleteWhatsApp');
    function refrescar(){
      var f = calcularFlete(elQ.value, elV.value, elD.value);
      elOut.innerHTML =
        '<div style="display:flex; justify-content:space-between; font-size:0.82rem; color:var(--muted);"><span>Salida de cisterna</span><span>' + formatMoneda(f.base) + '</span></div>' +
        '<div style="display:flex; justify-content:space-between; font-size:0.82rem; color:var(--muted);"><span>' + f.volumen + ' m³ × ' + formatMoneda(FLETE_POR_M3) + '</span><span>' + formatMoneda(f.subM3) + '</span></div>' +
        '<div style="display:flex; justify-content:space-between; font-size:0.82rem; color:var(--muted);"><span>Zona: ' + escapeHtml(f.cuadrante) + '</span><span>' + formatMoneda(f.recargoZona) + '</span></div>' +
        (f.recargoTanque ? '<div style="display:flex; justify-content:space-between; font-size:0.82rem; color:var(--muted);"><span>Tanque elevado</span><span>' + formatMoneda(f.recargoTanque) + '</span></div>' : '') +
        '<div style="display:flex; justify-content:space-between; font-weight:800; font-size:1.15rem; margin-top:8px; padding-top:8px; border-top:1px solid var(--border);"><span>Estimado</span><span class="mono">' + formatMoneda(f.total) + '</span></div>';
      var msg = 'Hola WaterCore Space, cotización desde la web:\n' +
        '• Zona: ' + f.cuadrante + '\n' +
        '• Volumen: ' + f.volumen + ' m³\n' +
        '• Descarga: ' + (elD.value === 'tanque' ? 'tanque elevado' : 'a nivel') + '\n' +
        '• Flete estimado: ' + formatMoneda(f.total) + '\n' +
        '¿Me confirman disponibilidad y precio final?';
      elWa.href = 'https://wa.me/51958132361?text=' + encodeURIComponent(msg);
    }
    form.addEventListener('input', refrescar);
    form.addEventListener('change', refrescar);
    refrescar();
  })();

  /* ---------- Mi Perfil / Billetera — comisión del 5% por viaje completado ---------- */
  function formatMoneda(n){ return 'S/. ' + (Number(n) || 0).toFixed(2); }

  // Movimientos de comisión de un chofer: 5% de cada viaje Completado cuyo campo "Chofer"
  // (pedidos.chofer) es exactamente cred.nombre, más cualquier ajuste manual de
  // AJUSTES_HISTORICOS para su correo (ej. saldo arrastrado de antes de este sistema). Un
  // ajuste manual también cuenta como día trabajado, igual que un viaje real.
  // Cuánto ve el CHOFER en su propia "Mi Perfil / Billetera" por un viaje — sigue la misma
  // política configurada por su empresa (ver configPagosDe()), pero con un "legado" propio
  // (5% del precio) distinto al de manoDeObra() (escalonado 20/10): son dos vistas que ya
  // convivían con números distintos antes de este cambio (billetera personal vs. gasto de
  // planilla en Contabilidad), así que una empresa que no configura nada no ve mover ninguna
  // de las dos. En cuanto la empresa SÍ configura una modalidad real, ambas la siguen igual.
  function pagoChoferPorViaje(p){
    var cfg = configPagosDe(p.empresaId || 'kunturmasha');
    var precio = Number(p.precio) || 0;
    if(cfg.choferModalidad === 'porcentaje_viaje') return precio * ((Number(cfg.choferMonto) || 0) / 100);
    if(cfg.choferModalidad === 'fijo_viaje') return Number(cfg.choferMonto) || 0;
    if(cfg.choferModalidad === 'fijo_dia') return 0;
    return precio * COMISION_ESTANDAR; // 'legado'
  }
  function calcularComisionesChofer(cred){
    // Bug corregido: además del nombre exacto, exige la misma empresa que la credencial —
    // sin esto, dos choferes de empresas distintas con el mismo nombre (posible con el
    // Directorio Central de 150 cuentas, ver generarDirectorioCentral()) mezclarían sus
    // comisiones entre sí.
    var completados = pedidos.filter(function(p){ return p.estado === 'Completado' && p.chofer === cred.nombre && (p.empresaId || 'kunturmasha') === (cred.empresaId || 'kunturmasha'); });
    var movsViajes = completados.map(function(p){ return { fecha: p.fecha, concepto: 'Viaje — ' + (p.cliente || p.id), monto: pagoChoferPorViaje(p) }; }).filter(function(m){ return m.monto > 0; });
    var diasFijoVistos = {};
    completados.forEach(function(p){
      var empresaId = p.empresaId || 'kunturmasha';
      var cfg = configPagosDe(empresaId);
      if(cfg.choferModalidad !== 'fijo_dia') return;
      var clave = empresaId + '|' + p.fecha;
      if(diasFijoVistos[clave]) return;
      diasFijoVistos[clave] = true;
      movsViajes.push({ fecha: p.fecha, concepto: 'Sueldo fijo diario — ' + p.fecha, monto: Number(cfg.choferMonto) || 0 });
    });
    var ajustes = AJUSTES_HISTORICOS.filter(function(a){ return a.email === cred.email && a.tipo === 'chofer'; });
    var movsAjustes = ajustes.map(function(a){ return { fecha: a.fecha, concepto: a.concepto || 'Ajuste manual', monto: a.monto }; });
    var movimientos = movsViajes.concat(movsAjustes).sort(function(x, y){ return y.fecha.localeCompare(x.fecha); });
    var saldo = movimientos.reduce(function(s, m){ return s + m.monto; }, 0);
    var dias = Array.from(new Set(completados.map(function(p){ return p.fecha; }).concat(ajustes.map(function(a){ return a.fecha; })))).length;
    return { saldo: saldo, dias: dias, viajes: completados.length, movimientos: movimientos };
  }

  // Comisión de promotor (5%) de una PERSONA (no de una cuenta puntual) — identificada por
  // pedidos.promotorEmail, que llena el campo "Conseguido por / Promotor" del formulario de
  // Despacho. Cualquiera del personal puede aparecer ahí (Administradores y Choferes
  // incluidos, no solo Promotores) — por eso se calcula sobre PERSONAS/perteneceAPersona(),
  // que junta las cuentas de una misma persona (ej. Piero: admin1 + chofer1) en una sola
  // billetera de promotor, sin importar con cuál haya iniciado sesión quien consulta.
  // Comisión de promotor por UN pedido, según la política de la empresa dueña de ese pedido
  // (ver configPagosDe()) — 0 si esa empresa deshabilitó promotores, sin importar quién lo
  // haya conseguido. "fijo_dia" devuelve 0 aquí: se agrega una sola vez por día más abajo.
  function comisionPromotorDePedido(p){
    var cfg = configPagosDe(p.empresaId || 'kunturmasha');
    if(!cfg.promotorHabilitado) return 0;
    var precio = Number(p.precio) || 0;
    if(cfg.promotorModalidad === 'fijo_viaje') return Number(cfg.promotorMonto) || 0;
    if(cfg.promotorModalidad === 'fijo_dia') return 0;
    return precio * ((Number(cfg.promotorMonto) || 0) / 100); // 'porcentaje_viaje' (y default)
  }

  /* ==========================================================================
     Bono ÚNICO de apertura del promotor (roadmap). Se paga UNA sola vez por cada
     CLIENTE NUEVO que un promotor abre — su primer pedido registrado en el
     sistema — cuando ese primer pedido llega a "Completado". Es aparte de las
     regalías por viaje (comisionPromotorDePedido). El monto va por tramos según
     el precio de ese primer servicio (S/. 10 – S/. 30). Ajustable aquí.
     ========================================================================== */
  var BONO_APERTURA_TRAMOS = [
    { max: 100,      monto: 10 },   // primer servicio de S/. 100 o menos
    { max: 200,      monto: 20 },   // hasta S/. 200
    { max: Infinity, monto: 30 }    // más de S/. 200
  ];
  function bonoAperturaDe(precioPrimerPedido){
    var precio = Number(precioPrimerPedido) || 0;
    for(var i = 0; i < BONO_APERTURA_TRAMOS.length; i++){
      if(precio <= BONO_APERTURA_TRAMOS[i].max) return BONO_APERTURA_TRAMOS[i].monto;
    }
    return 0;
  }
  // Primer pedido (el más antiguo por fecha, luego por orden) de cada codigoCliente.
  // Memoizado por longitud de `pedidos` para no recalcularlo en cada fila de la
  // tabla de Admin (renderPerfil llama a calcularComisionesPromotor una vez por persona).
  var _primerPedidoCache = { firma: null, mapa: null };
  function primerPedidoPorCliente(){
    if(_primerPedidoCache.firma === pedidos.length && _primerPedidoCache.mapa) return _primerPedidoCache.mapa;
    var mapa = {};
    pedidos.forEach(function(p){
      var cod = p.codigoCliente;
      if(!cod) return;
      var actual = mapa[cod];
      var clave = (p.fecha || '') + '#' + String(p.orden || 0).padStart(6, '0');
      if(!actual || clave < actual.__clave){ p.__clave = clave; mapa[cod] = p; }
    });
    _primerPedidoCache = { firma: pedidos.length, mapa: mapa };
    return mapa;
  }
  // Clientes que ESTA persona abrió y cuyo primer pedido ya está Completado.
  function aperturasDePersona(persona){
    var mapa = primerPedidoPorCliente();
    var out = [];
    Object.keys(mapa).forEach(function(cod){
      var primero = mapa[cod];
      if(primero.estado !== 'Completado') return;
      if(!perteneceAPersona(primero.promotorEmail, persona)) return;
      out.push({ codigo: cod, pedido: primero, bono: bonoAperturaDe(primero.precio) });
    });
    return out;
  }
  function calcularComisionesPromotor(persona){
    var completados = pedidos.filter(function(p){ return p.estado === 'Completado' && perteneceAPersona(p.promotorEmail, persona); });
    var movsViajes = completados.map(function(p){ return { fecha: p.fecha, concepto: 'Pedido — ' + (p.cliente || p.id), monto: comisionPromotorDePedido(p) }; }).filter(function(m){ return m.monto > 0; });
    // "fijo_dia": una sola vez por cada (empresa, día) con al menos un pedido completado de
    // esta persona, si esa empresa habilitó promotores con esa modalidad.
    var diasFijoVistos = {};
    completados.forEach(function(p){
      var empresaId = p.empresaId || 'kunturmasha';
      var cfg = configPagosDe(empresaId);
      if(!cfg.promotorHabilitado || cfg.promotorModalidad !== 'fijo_dia') return;
      var clave = empresaId + '|' + p.fecha;
      if(diasFijoVistos[clave]) return;
      diasFijoVistos[clave] = true;
      movsViajes.push({ fecha: p.fecha, concepto: 'Sueldo fijo diario de promotor — ' + p.fecha, monto: Number(cfg.promotorMonto) || 0 });
    });
    // Bono ÚNICO de apertura por cada cliente nuevo que esta persona abrió (ver
    // aperturasDePersona()) — se suma a la billetera igual que las regalías por viaje.
    var aperturas = aperturasDePersona(persona);
    var movsBono = aperturas.map(function(ap){
      return { fecha: ap.pedido.fecha, concepto: 'Bono de apertura — ' + (ap.pedido.cliente || ap.codigo), monto: ap.bono };
    }).filter(function(m){ return m.monto > 0; });
    var totalBono = movsBono.reduce(function(s, m){ return s + m.monto; }, 0);

    var ajustes = AJUSTES_HISTORICOS.filter(function(a){ return persona.emails.indexOf(a.email) !== -1 && a.tipo === 'promotor'; });
    var movsAjustes = ajustes.map(function(a){ return { fecha: a.fecha, concepto: a.concepto || 'Ajuste manual', monto: a.monto }; });
    var movimientos = movsViajes.concat(movsBono, movsAjustes).sort(function(x, y){ return y.fecha.localeCompare(x.fecha); });
    var saldo = movimientos.reduce(function(s, m){ return s + m.monto; }, 0);
    var dias = Array.from(new Set(completados.map(function(p){ return p.fecha; }).concat(ajustes.map(function(a){ return a.fecha; })))).length;
    var regalias = movsViajes.reduce(function(s, m){ return s + m.monto; }, 0);
    return {
      saldo: saldo, dias: dias, viajes: completados.length, movimientos: movimientos,
      bonoApertura: totalBono, clientesNuevos: aperturas.length, regalias: regalias
    };
  }

  function tablaMovimientos(movimientos){
    if(!movimientos.length) return '<div class="empty-state">Todavía no hay movimientos.</div>';
    var filas = movimientos.map(function(m){
      return '<tr><td>' + escapeHtml(m.fecha) + '</td><td>' + escapeHtml(m.concepto) + '</td><td class="num">' + formatMoneda(m.monto) + '</td></tr>';
    }).join('');
    return '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Fecha</th><th>Concepto</th><th class="num">Monto</th></tr></thead><tbody>' + filas + '</tbody></table></div>';
  }

  // Panel "Política de pagos" — cada Administrador de empresa define aquí cómo se le paga a
  // chofer, ayudante y promotor (ver configPagosDe()/guardarConfigPagos()). El <select> de
  // chofer/ayudante trae una opción temporal "Aún no configurado" SOLO mientras la empresa
  // sigue en modo "legado" (nunca guardó nada) — desaparece en cuanto se guarda una modalidad
  // real, porque configPagosDe() ya no devuelve 'legado' para esa empresa nunca más.
  var OPCIONES_MODALIDAD_PAGO = [
    { value: 'fijo_dia', label: 'Sueldo fijo diario (S/.)' },
    { value: 'fijo_viaje', label: 'Pago fijo por viaje (S/.)' },
    { value: 'porcentaje_viaje', label: 'Porcentaje por viaje (%)' }
  ];
  var OPCIONES_MODALIDAD_PROMOTOR = [
    { value: 'fijo_dia', label: 'Monto fijo diario (S/.)' },
    { value: 'fijo_viaje', label: 'Monto fijo por viaje conseguido (S/.)' },
    { value: 'porcentaje_viaje', label: 'Porcentaje por viaje (%)' }
  ];
  function selectModalidadHtml(id, opciones, actual){
    var placeholder = actual === 'legado' ? '<option value="legado" selected>— Aún no configurado (usa el valor histórico) —</option>' : '';
    return '<select id="' + id + '">' + placeholder + opciones.map(function(o){
      return '<option value="' + o.value + '"' + (o.value === actual ? ' selected' : '') + '>' + o.label + '</option>';
    }).join('') + '</select>';
  }
  function panelConfigPagosHtml(empresaId){
    var cfg = configPagosDe(empresaId);
    var empresa = buscarEmpresa(empresaId);
    return '<div class="panel" style="margin-top:16px;">' +
        '<h2>⚙️ Política de pagos — ' + escapeHtml(empresa.nombre) + '</h2>' +
        '<p class="campo-nota" style="margin:0 0 12px;">Define cómo se le paga a chofer, ayudante y promotor en tu empresa. Se guarda por empresa (config_empresas) y desde que la guardas, reemplaza el cálculo de siempre en Contabilidad y en "Mi Perfil" — lo ya registrado antes de guardar no cambia de golpe, solo lo que se calcula de aquí en adelante.</p>' +
        '<form id="formConfigPagos">' +
          '<div class="form-row">' +
            '<div class="form-group"><label>Pago a Chofer — modalidad</label>' + selectModalidadHtml('cfgChoferModalidad', OPCIONES_MODALIDAD_PAGO, cfg.choferModalidad) + '</div>' +
            '<div class="form-group"><label>Monto</label><input type="number" id="cfgChoferMonto" min="0" step="0.01" value="' + (cfg.choferMonto || 0) + '"></div>' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="form-group"><label>Pago a Ayudante — modalidad</label>' + selectModalidadHtml('cfgAyudanteModalidad', OPCIONES_MODALIDAD_PAGO, cfg.ayudanteModalidad) + '</div>' +
            '<div class="form-group"><label>Monto</label><input type="number" id="cfgAyudanteMonto" min="0" step="0.01" value="' + (cfg.ayudanteMonto || 0) + '"></div>' +
          '</div>' +
          '<div class="form-group"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="cfgPromotorHabilitado"' + (cfg.promotorHabilitado ? ' checked' : '') + '> Habilitar comisión de Promotor en esta empresa</label></div>' +
          '<div id="cfgPromotorCampos" class="form-row"' + (cfg.promotorHabilitado ? '' : ' hidden') + '>' +
            '<div class="form-group"><label>Comisión al Promotor — modalidad</label>' + selectModalidadHtml('cfgPromotorModalidad', OPCIONES_MODALIDAD_PROMOTOR, cfg.promotorModalidad) + '</div>' +
            '<div class="form-group"><label>Monto</label><input type="number" id="cfgPromotorMonto" min="0" step="0.01" value="' + (cfg.promotorMonto || 0) + '"></div>' +
          '</div>' +
          '<p class="campo-nota" id="notaPromotorDeshabilitado"' + (cfg.promotorHabilitado ? ' hidden' : '') + '>Con los promotores deshabilitados, el campo "Conseguido por / Promotor" se oculta en Despacho y la comisión de promotor de esta empresa queda en S/. 0.00.</p>' +
          '<button type="submit" class="btn">Guardar política de pagos</button>' +
          '<p class="modal-status" id="cfgPagosStatus"></p>' +
        '</form>' +
      '</div>';
  }
  function activarConfigPagos(empresaId){
    var form = document.getElementById('formConfigPagos');
    if(!form) return;
    var chkPromotor = document.getElementById('cfgPromotorHabilitado');
    chkPromotor.addEventListener('change', function(){
      document.getElementById('cfgPromotorCampos').hidden = !chkPromotor.checked;
      document.getElementById('notaPromotorDeshabilitado').hidden = chkPromotor.checked;
    });
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var cfg = {
        choferModalidad: document.getElementById('cfgChoferModalidad').value,
        choferMonto: parseFloat(document.getElementById('cfgChoferMonto').value) || 0,
        ayudanteModalidad: document.getElementById('cfgAyudanteModalidad').value,
        ayudanteMonto: parseFloat(document.getElementById('cfgAyudanteMonto').value) || 0,
        promotorHabilitado: chkPromotor.checked,
        promotorModalidad: document.getElementById('cfgPromotorModalidad').value,
        promotorMonto: parseFloat(document.getElementById('cfgPromotorMonto').value) || 0
      };
      guardarConfigPagos(empresaId, cfg);
      var status = document.getElementById('cfgPagosStatus');
      status.textContent = '✅ Política de pagos guardada para ' + buscarEmpresa(empresaId).nombre + '.';
      status.className = 'modal-status ok';
      renderTodo(); // refresca Agenda/Contabilidad si estaban mostrando cifras ya calculadas
    });
  }

  // Bloque "Mi nombre" — editable desde Mi Perfil, se guarda solo en este navegador (ver
  // nombreMostrado()). No afecta el <select> de Chofer ni el cálculo de comisiones.
  function editorNombreHtml(cred){
    return '<div class="panel" style="margin-bottom:16px;">' +
      '<h2>Mi nombre</h2>' +
      '<p class="campo-nota" style="margin:0 0 10px;">Cómo te ves en esta pantalla (solo en este navegador) — no cambia tu correo ni desconecta tus viajes ya registrados.</p>' +
      '<div class="form-group" style="max-width:360px;"><input type="text" id="perfilNombreInput" value="' + escapeHtml(nombreMostrado(cred)) + '" placeholder="' + escapeHtml(cred.nombre) + '"></div>' +
      '<button type="button" class="btn" id="btnGuardarNombrePerfil">Guardar nombre</button>' +
      '<p class="modal-status" id="perfilNombreStatus"></p>' +
    '</div>';
  }
  function activarEditorNombre(cred){
    document.getElementById('btnGuardarNombrePerfil').addEventListener('click', function(){
      var nuevo = document.getElementById('perfilNombreInput').value.trim();
      guardarNombrePerfil(cred.email, nuevo);
      actualizarSesionUI();
      var status = document.getElementById('perfilNombreStatus');
      status.textContent = 'Guardado.';
      status.className = 'modal-status ok';
    });
  }

  function renderPerfil(){
    var cont = document.getElementById('perfilContenido');
    if(!usuarioActual){
      cont.innerHTML = '<div class="panel"><div class="empty-state">Inicia sesión como Administrador, Chofer o Promotor (botón "🔐 Acceso personal") para ver tu billetera.</div></div>';
      return;
    }
    var credPropia = buscarCredencial(usuarioActual.email);
    var personaPropia = personaDeCredencial(credPropia);
    if(rolDbActual === 'Chofer'){
      var c = calcularComisionesChofer(credPropia);
      var pc = calcularComisionesPromotor(personaPropia);
      cont.innerHTML = editorNombreHtml(credPropia) +
        '<div class="stats-strip">' +
          tileHtml({ label: 'Saldo por comisión (5%)', value: formatMoneda(c.saldo), cls: 'good' }) +
          tileHtml({ label: 'Días trabajados', value: c.dias }) +
          tileHtml({ label: 'Viajes completados', value: c.viajes }) +
        '</div>' +
        '<div class="panel" style="margin-top:16px;"><h2>Historial de movimientos</h2>' + tablaMovimientos(c.movimientos) + '</div>' +
        // Como chofer también puedes traer clientes (te eligen en "Conseguido por" al
        // registrar su pedido) — esa comisión de promotor es aparte de la de manejar,
        // y se liquida igual a tu billetera.
        '<div class="panel" style="margin-top:16px;"><h2>Comisión como Promotor comisionista</h2>' +
          '<div class="stats-strip">' +
            tileHtml({ label: 'Saldo total', value: formatMoneda(pc.saldo), cls: 'good' }) +
            tileHtml({ label: 'Regalías por viaje', value: formatMoneda(pc.regalias) }) +
            tileHtml({ label: 'Bono de apertura', value: formatMoneda(pc.bonoApertura), cls: 'accent' }) +
            tileHtml({ label: 'Clientes nuevos', value: pc.clientesNuevos }) +
          '</div>' + tablaMovimientos(pc.movimientos) +
        '</div>';
      activarEditorNombre(credPropia);
    } else if(rolDbActual === 'Promotor'){
      var a = calcularComisionesPromotor(personaPropia);
      cont.innerHTML = editorNombreHtml(credPropia) +
        '<div class="stats-strip">' +
          tileHtml({ label: 'Saldo total', value: formatMoneda(a.saldo), cls: 'good' }) +
          tileHtml({ label: 'Regalías por viaje', value: formatMoneda(a.regalias) }) +
          tileHtml({ label: 'Bono de apertura', value: formatMoneda(a.bonoApertura), cls: 'accent' }) +
          tileHtml({ label: 'Clientes nuevos abiertos', value: a.clientesNuevos }) +
          tileHtml({ label: 'Pedidos completados', value: a.viajes }) +
        '</div>' +
        '<div class="panel" style="margin-top:16px;">' +
          '<h2>Módulo de comisiones</h2>' +
          '<p class="campo-nota" style="margin:0 0 10px;">Tu billetera tiene dos partes: <strong>bono único de apertura</strong> (S/. 10–30 la primera vez que un cliente nuevo que tú trajiste completa su primer servicio, según el precio de ese servicio) y <strong>regalías por viaje</strong> (por cada viaje entregado de un cliente que conseguiste).</p>' +
          tablaMovimientos(a.movimientos) +
        '</div>';
      activarEditorNombre(credPropia);
    } else if(rolDbActual === 'Administrador'){
      // Solo el personal CONFIRMADO en la plantilla de la empresa activa (ver
      // plantillaEmpresas / Ajustes → "Personal de la empresa"). Una empresa recién creada,
      // sin nadie confirmado, ve estas tablas vacías y sus totales en S/. 0.00.
      var choferes = rosterDeEmpresa(empresaActivaId)
        .filter(function(m){ return m.cred && m.roles.indexOf('chofer') !== -1; })
        .map(function(m){ return Object.assign({}, m.cred, calcularComisionesChofer(m.cred)); });
      // Comisiones por viajes conseguidos: cualquier rol puede traer un cliente, pero solo
      // el personal confirmado de esta empresa — una fila por PERSONA, no por cuenta.
      var promotores = personasDeEmpresa(empresaActivaId).map(function(pe){ return Object.assign({}, pe, calcularComisionesPromotor(pe)); });
      var totalChofer = choferes.reduce(function(s, c){ return s + c.saldo; }, 0);
      var totalPromotor = promotores.reduce(function(s, pe){ return s + pe.saldo; }, 0);
      var totalBonoApertura = promotores.reduce(function(s, pe){ return s + (pe.bonoApertura || 0); }, 0);
      var totalRegalias = promotores.reduce(function(s, pe){ return s + (pe.regalias || 0); }, 0);
      var totalIngresos = pedidos.filter(function(p){ return p.estado === 'Completado'; }).reduce(function(s, p){ return s + (Number(p.precio) || 0); }, 0);
      var filasChofer = choferes.map(function(c){
        return '<tr><td>' + escapeHtml(nombreMostrado(c)) + '</td><td class="num">' + c.dias + '</td><td class="num">' + c.viajes + '</td><td class="num">' + formatMoneda(c.saldo) + '</td></tr>';
      }).join('');
      var filasPromotor = promotores.map(function(pe){
        return '<tr><td>' + escapeHtml(nombrePersonaMostrado(pe)) + '</td><td class="num">' + (pe.clientesNuevos || 0) + '</td><td class="num">' + formatMoneda(pe.bonoApertura || 0) + '</td><td class="num">' + pe.viajes + '</td><td class="num">' + formatMoneda(pe.regalias || 0) + '</td><td class="num">' + formatMoneda(pe.saldo) + '</td></tr>';
      }).join('');
      cont.innerHTML = editorNombreHtml(credPropia) +
        '<div class="stats-strip">' +
          tileHtml({ label: 'Ingresos (completados)', value: formatMoneda(totalIngresos), cls: 'accent' }) +
          tileHtml({ label: 'Comisiones a choferes', value: formatMoneda(totalChofer), cls: 'good' }) +
          tileHtml({ label: 'Bono de apertura (promotores)', value: formatMoneda(totalBonoApertura), cls: 'accent' }) +
          tileHtml({ label: 'Regalías por viaje (promotores)', value: formatMoneda(totalRegalias), cls: 'good' }) +
        '</div>' +
        '<div class="panel" style="margin-top:16px;"><h2>Choferes — días trabajados y comisión</h2>' +
          '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Chofer</th><th class="num">Días trabajados</th><th class="num">Viajes</th><th class="num">Saldo / Remuneración</th></tr></thead><tbody>' + filasChofer + '</tbody></table></div>' +
        '</div>' +
        '<div class="panel" style="margin-top:16px;"><h2>Promotores de campo — bono de apertura + regalías por viaje</h2>' +
          '<p class="campo-nota" style="margin:0 0 12px;">Bono único de apertura (S/. 10–30) por cada cliente nuevo que completa su primer servicio · regalías por cada viaje entregado. Cualquiera puede traer un cliente — Administradores y Choferes incluidos.</p>' +
          '<div class="tabla-wrap"><table class="tabla-registro"><thead><tr><th>Persona</th><th class="num">Clientes nuevos</th><th class="num">Bono apertura</th><th class="num">Viajes</th><th class="num">Regalías</th><th class="num">Saldo total</th></tr></thead><tbody>' + filasPromotor + '</tbody></table></div>' +
        '</div>' +
        panelConfigPagosHtml(empresaActivaId);
      activarEditorNombre(credPropia);
      activarConfigPagos(empresaActivaId);
    }
  }

  /* ---------- Render general ---------- */
  function renderTodo(){
    document.getElementById('fechaLarga').textContent = formatearFechaLarga(fechaSeleccionada);
    renderWeekStrip();
    renderStats();
    renderLista();
    actualizarListasPersonal();
    if(vistaActual === 'contabilidad') renderContabilidad();
    if(vistaActual === 'perfil') renderPerfil();
    if(vistaActual === 'hub') renderHub();
  }

  // Arranque: la app se muestra de inmediato (clientes sin cuenta ven agenda/cotizar ya
  // mismo); si hay una sesión de personal guardada de una visita anterior, se restaura.
  // La sincronización con Supabase arranca siempre que haya conexión, haya o no sesión.
  function iniciarApp(){
    var sesionGuardada = cargarSesionPersonal();
    if(sesionGuardada){
      entrarComoPersonal(sesionGuardada);
    } else {
      actualizarSesionUI();
      aplicarRol('cliente');
      aplicarTinteSegunContexto(false);
    }
    // Atajos de la PWA / enlaces directos: /?vista=agenda|hub|agendar|... — solo si
    // esa vista está permitida para el rol actual (ver VISTAS_POR_ROL).
    try{
      var pedida = new URLSearchParams(location.search).get('vista');
      if(pedida){
        var permitidas = (VISTAS_POR_ROL[rolActivo] || {}).tabs || [];
        if(permitidas.indexOf(pedida) !== -1) irAVista(pedida);
      }
    }catch(e){}
    if(supa) iniciarSupabase();
  }

  // ---- Ripple universal al hacer clic en controles interactivos (delegado en document,
  // una sola vez) — funciona también en elementos repintados con innerHTML. Respeta
  // prefers-reduced-motion (el @media de arriba anula la animación). ----
  (function initRipples(){
    var SEL = '.btn, .btn-ghost, .btn-icon, .btn-mini, .view-tab, .sub-tab, .chip, .day-chip, .filter-btn, .home-card, .rol-pill';
    document.addEventListener('pointerdown', function(e){
      var el = e.target.closest && e.target.closest(SEL);
      if(!el || el.disabled) return;
      var cs = getComputedStyle(el);
      if(cs.position === 'static') el.style.position = 'relative';
      el.style.overflow = 'hidden';
      var rect = el.getBoundingClientRect();
      var span = document.createElement('span');
      span.className = 'ripple';
      span.style.left = (e.clientX - rect.left) + 'px';
      span.style.top = (e.clientY - rect.top) + 'px';
      var d = Math.max(rect.width, rect.height);
      span.style.width = span.style.height = d + 'px';
      span.style.marginLeft = span.style.marginTop = (-d / 2) + 'px';
      el.appendChild(span);
      setTimeout(function(){ span.remove(); }, 620);
    }, { passive: true });
  })();

  document.getElementById('fecha').value = fechaSeleccionada;
  togglePiso();
  actualizarTabsPorRol();
  actualizarPromotorUI();
  actualizarUIPagosSegunEmpresa();
  renderTodo();
  iniciarApp();
})();
