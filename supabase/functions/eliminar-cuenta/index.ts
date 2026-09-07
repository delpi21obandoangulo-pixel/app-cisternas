// ============================================================================
// Edge Function: eliminar-cuenta
// ----------------------------------------------------------------------------
// PLANTILLA — NO desplegada todavía. Requiere que primero exista Supabase Auth
// (Fase 1: migrar el login del personal a supabase.auth) y una tabla de perfiles
// del personal (p. ej. public.personal { user_id uuid pk, email, rol, empresa_id }).
//
// Cuando eso exista:
//   1. supabase secrets set SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=...
//   2. supabase functions deploy eliminar-cuenta
//   3. La app (Ajustes → "Eliminar mi cuenta") llama a esta función con el JWT
//      de sesión del usuario en el header Authorization.
//
// Qué hace: verifica el JWT, identifica al usuario, ANONIMIZA/elimina sus datos
// de acceso y de perfil, y borra su usuario de Auth. Los registros de negocio
// (pedidos, gastos, comisiones) NO se borran — se desligan del acceso personal —
// por obligación contable (ver privacidad.html §6).
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

  // 1. Identificar al solicitante a partir de SU token (no del service role).
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await asUser.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "no_autenticado" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // 2. Con service role: desligar/anonimizar y borrar.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 2a. Desligar los registros de negocio del acceso personal (no se borran).
  //     Ajustar nombres de columnas a la tabla real cuando exista.
  await admin.from("pedidos")
    .update({ promotor_email: null })
    .eq("promotor_email", user.email ?? "__none__");

  // 2b. Borrar el perfil del personal.
  await admin.from("personal").delete().eq("user_id", user.id);

  // 2c. Borrar el usuario de Auth.
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    return new Response(JSON.stringify({ error: "fallo_al_borrar", detalle: delErr.message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, borrado: user.id }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
