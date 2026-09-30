// Ponte in SOLA LETTURA verso AlfaDocs.
// Ogni sede è uno studio AlfaDocs separato, con la sua chiave (segreti ALFADOCS_KEY_BO / _FA / _RN;
// la prima chiave creata, ALFADOCS_API_KEY, è quella di Faenza). Le chiavi non arrivano mai ai telefoni.
// Risponde solo agli utenti dell'app presenti nella tabella "accessi".
import { createClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://app.alfadocs.com/api/v1";
const KEYS: Record<string, string> = {
  BO: Deno.env.get("ALFADOCS_KEY_BO") ?? "",
  FA: Deno.env.get("ALFADOCS_KEY_FA") ?? Deno.env.get("ALFADOCS_API_KEY") ?? "",
  RN: Deno.env.get("ALFADOCS_KEY_RN") ?? "",
};
const SEDI = Object.keys(KEYS).filter((s) => KEYS[s]);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class AlfaError extends Error {
  constructor(public status: number, public body: unknown) { super(`AlfaDocs ${status}`); }
}

// Unica funzione che parla con AlfaDocs: solo GET.
async function get(sede: string, path: string, params: Record<string, string | number> = {}) {
  const key = KEYS[sede];
  if (!key) throw new AlfaError(400, `Sede ${sede} non collegata`);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method: "GET", headers: { "X-Api-Key": key, Accept: "application/json" } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* testo semplice */ }
  if (!res.ok) throw new AlfaError(res.status, body);
  return body;
}

// Percorsi leggibili con l'azione "read" (diagnostica): solo quelli che servono all'app.
const ALLOWED = [
  /^\/me$/,
  /^\/practices\/\d+\/archives\/\d+\/(patients|appointments|operators|chairs)$/,
  /^\/practices\/\d+\/archives\/\d+\/patients\/\d+(\/care-plans)?$/,
  /^\/practices\/\d+\/archives\/\d+\/care-plans\/\d+$/,
];

// ---------- letture per l'app ----------
type Ctx = { base: string; operators: Map<number, string>; chairs: Map<number, string>; at: number };
const ctxs = new Map<string, Ctx>();
const list = (r: unknown) =>
  (Array.isArray(r) ? r : ((r as { data?: unknown[] }).data ?? (r as { results?: unknown[] }).results ?? [])) as Record<string, unknown>[];

async function context(sede: string): Promise<Ctx> {
  const c = ctxs.get(sede);
  if (c && Date.now() - c.at < 10 * 60_000) return c;
  const me = (await get(sede, "/me")) as { data: { practiceId: number; archiveId: number } };
  const base = `/practices/${me.data.practiceId}/archives/${me.data.archiveId}`;
  const [ops, chs] = await Promise.all([get(sede, base + "/operators"), get(sede, base + "/chairs")]);
  const fresh = {
    base,
    operators: new Map(list(ops).map((o) => [Number(o.id), String(o.name ?? `${o.firstName ?? ""} ${o.lastName ?? ""}`).trim()])),
    chairs: new Map(list(chs).map((c) => [Number(c.id), String(c.name ?? "")])),
    at: Date.now(),
  };
  ctxs.set(sede, fresh);
  return fresh;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Cerca il cognome in tutte le sedi collegate
async function searchPatients(p: Record<string, string | number>) {
  const lastName = String(p.lastName ?? "").trim();
  const firstName = String(p.firstName ?? "").trim();
  if (lastName.length < 2) return { sedi: SEDI, total: 0, results: [], errors: [] };
  const params: Record<string, string | number> = { lastName, limit: 20 };
  if (firstName) params.firstName = firstName;
  const per = await Promise.all(SEDI.map(async (sede) => {
    try {
      const { base } = await context(sede);
      const r = (await get(sede, base + "/patients", params)) as { total?: number; results?: Record<string, unknown>[] };
      return {
        sede, total: r.total ?? 0,
        results: (r.results ?? []).map((x) => ({
          sede, id: x.id, firstName: x.firstName ?? "", lastName: x.lastName ?? "",
          birthYear: typeof x.dateBirth === "string" ? x.dateBirth.slice(0, 4) : "",
        })),
      };
    } catch { return { sede, total: 0, results: [], error: true }; }
  }));
  return {
    sedi: SEDI,
    total: per.reduce((a, x) => a + x.total, 0),
    results: per.flatMap((x) => x.results),
    errors: per.filter((x) => "error" in x).map((x) => x.sede),
  };
}

async function patientDetail(sede: string, patientId: number) {
  if (!KEYS[sede]) throw new AlfaError(400, "Sede non collegata");
  if (!Number.isFinite(patientId) || patientId <= 0) throw new AlfaError(400, "patientId mancante");
  const c = await context(sede);
  const [patient, plans] = await Promise.all([
    get(sede, `${c.base}/patients/${patientId}`) as Promise<{ data?: Record<string, unknown> } & Record<string, unknown>>,
    get(sede, `${c.base}/patients/${patientId}/care-plans`) as Promise<Record<string, unknown>[]>,
  ]);
  const pd = (patient.data ?? patient) as Record<string, unknown>;

  // Denti con impianto (codice IMP) nei piani di cura non eliminati
  const live = (Array.isArray(plans) ? plans : []).filter((x) => !x.deleted);
  const details = await Promise.all(live.map((x) => get(sede, `${c.base}/care-plans/${x.id}`).catch(() => null)));
  const teeth: { tooth: string; done: boolean; plan: string; state: string }[] = [];
  for (const d of details) {
    const plan = ((d as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
    const codes = (plan.schemeCodes ?? {}) as Record<string, { code?: string; done?: boolean }[]>;
    for (const [tooth, arr] of Object.entries(codes)) {
      if (tooth === "general") continue;
      for (const s of arr) if (s.code === "IMP") teeth.push({ tooth, done: !!s.done, plan: String(plan.name ?? ""), state: String(plan.state ?? "") });
    }
  }
  teeth.sort((a, b) => Number(a.tooth) - Number(b.tooth));

  // Prossimo appuntamento nei prossimi 90 giorni (l'API accetta finestre di 30 giorni)
  const now = new Date();
  const windows = [0, 30, 60].map((o) => {
    const s = new Date(now.getTime() + o * 864e5), e = new Date(now.getTime() + (o + 29) * 864e5);
    return get(sede, `${c.base}/appointments`, { dateStart: ymd(s), dateEnd: ymd(e), patientId }).catch(() => ({ data: [] }));
  });
  const appts = (await Promise.all(windows)).flatMap((r) => list(r))
    .filter((a) => a.state !== "cancelled" && String(a.patientId) === String(patientId))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const next = appts[0];

  return {
    sede,
    patient: { id: patientId, firstName: pd.firstName ?? "", lastName: pd.lastName ?? "" },
    teeth,
    nextAppointment: next ? {
      date: String(next.date).slice(0, 10), sede,
      chair: c.chairs.get(Number(next.chairId)) ?? "",
      operator: c.operators.get(Number(next.operatorId)) ?? "",
    } : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: allowed } = await sb.rpc("is_allowed");
  if (allowed !== true) return json({ error: "Non autorizzato" }, 403);
  if (!SEDI.length) return json({ error: "Nessuna chiave AlfaDocs configurata" }, 500);

  let input: { action?: string; path?: string; params?: Record<string, string | number> };
  try { input = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const sede = String(input.params?.sede ?? "FA");

  try {
    if (input.action === "read") {
      const path = String(input.path ?? "");
      if (!ALLOWED.some((re) => re.test(path))) return json({ error: "Percorso non consentito" }, 400);
      const { sede: _s, ...params } = input.params ?? {};
      return json(await get(sede, path, params));
    }
    if (input.action === "search") return json(await searchPatients(input.params ?? {}));
    if (input.action === "patient") return json(await patientDetail(sede, Number(input.params?.patientId)));
    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    if (e instanceof AlfaError) return json({ error: "Errore AlfaDocs", status: e.status, body: e.body }, 502);
    return json({ error: "AlfaDocs non raggiungibile" }, 502);
  }
});
