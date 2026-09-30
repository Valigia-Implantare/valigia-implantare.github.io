// Ponte in SOLA LETTURA verso AlfaDocs.
// La chiave AlfaDocs resta qui (segreto ALFADOCS_API_KEY) e non arriva mai ai telefoni.
// Risponde solo agli utenti dell'app presenti nella tabella "accessi".
import { createClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://app.alfadocs.com/api/v1";
const KEY = Deno.env.get("ALFADOCS_API_KEY") ?? "";
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
async function get(path: string, params: Record<string, string | number> = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method: "GET", headers: { "X-Api-Key": KEY, Accept: "application/json" } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* testo semplice */ }
  if (!res.ok) throw new AlfaError(res.status, body);
  return body;
}

// Percorsi leggibili: solo quelli che servono all'app.
const ALLOWED = [
  /^\/me$/,
  /^\/archives\/current(\/id)?$/,
  /^\/practices\/\d+\/archives\/\d+\/(patients|appointments|care-plan-entries|operators|chairs|specialties)$/,
  /^\/practices\/\d+\/archives\/\d+\/patients\/\d+(\/care-plans)?$/,
  /^\/practices\/\d+\/archives\/\d+\/(appointments|care-plans|care-plan-entries)\/\d+(\/entries)?$/,
];

// ---------- letture per l'app ----------
type Ctx = { base: string; operators: Map<number, string>; chairs: Map<number, string>; at: number };
let ctx: Ctx | null = null;

async function context(): Promise<Ctx> {
  if (ctx && Date.now() - ctx.at < 10 * 60_000) return ctx;
  const me = (await get("/me")) as { data: { practiceId: number; archiveId: number } };
  const base = `/practices/${me.data.practiceId}/archives/${me.data.archiveId}`;
  const list = (r: unknown) => (Array.isArray(r) ? r : ((r as { data?: unknown[]; results?: unknown[] }).data ?? (r as { results?: unknown[] }).results ?? [])) as Record<string, unknown>[];
  const [ops, chs] = await Promise.all([get(base + "/operators"), get(base + "/chairs")]);
  ctx = {
    base,
    operators: new Map(list(ops).map((o) => [Number(o.id), String(o.name ?? `${o.firstName ?? ""} ${o.lastName ?? ""}`).trim()])),
    chairs: new Map(list(chs).map((c) => [Number(c.id), String(c.name ?? "")])),
    at: Date.now(),
  };
  return ctx;
}

const sedeFromChair = (name: string) => /bologna/i.test(name) ? "BO" : /faenza/i.test(name) ? "FA" : /rimini/i.test(name) ? "RN" : "";
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function searchPatients(p: Record<string, string | number>) {
  const lastName = String(p.lastName ?? "").trim();
  const firstName = String(p.firstName ?? "").trim();
  if (lastName.length < 2) return { results: [] };
  const { base } = await context();
  const params: Record<string, string | number> = { lastName, limit: 20 };
  if (firstName) params.firstName = firstName;
  const r = (await get(base + "/patients", params)) as { total?: number; results?: Record<string, unknown>[] };
  return {
    total: r.total ?? 0,
    results: (r.results ?? []).map((x) => ({
      id: x.id, firstName: x.firstName ?? "", lastName: x.lastName ?? "",
      birthYear: typeof x.dateBirth === "string" ? x.dateBirth.slice(0, 4) : "",
    })),
  };
}

async function patientDetail(patientId: number) {
  if (!Number.isFinite(patientId) || patientId <= 0) throw new AlfaError(400, "patientId mancante");
  const c = await context();
  const [patient, plans] = await Promise.all([
    get(`${c.base}/patients/${patientId}`) as Promise<{ data?: Record<string, unknown> } & Record<string, unknown>>,
    get(`${c.base}/patients/${patientId}/care-plans`) as Promise<Record<string, unknown>[]>,
  ]);
  const pd = (patient.data ?? patient) as Record<string, unknown>;

  // Denti con impianto (codice IMP) nei piani di cura non eliminati
  const live = (Array.isArray(plans) ? plans : []).filter((x) => !x.deleted);
  const details = await Promise.all(live.map((x) => get(`${c.base}/care-plans/${x.id}`).catch(() => null)));
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
    return get(`${c.base}/appointments`, { dateStart: ymd(s), dateEnd: ymd(e), patientId }).catch(() => ({ data: [] }));
  });
  const appts = (await Promise.all(windows)).flatMap((r) => ((r as { data?: Record<string, unknown>[] }).data ?? []))
    .filter((a) => a.state !== "cancelled" && String(a.patientId) === String(patientId))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const next = appts[0];
  const chair = next ? c.chairs.get(Number(next.chairId)) ?? "" : "";

  return {
    patient: { id: patientId, firstName: pd.firstName ?? "", lastName: pd.lastName ?? "" },
    teeth,
    nextAppointment: next ? {
      date: String(next.date).slice(0, 10), chair, sede: sedeFromChair(chair),
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
  if (!KEY) return json({ error: "Chiave AlfaDocs non configurata" }, 500);

  let input: { action?: string; path?: string; params?: Record<string, string | number> };
  try { input = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }

  try {
    if (input.action === "read") {
      const path = String(input.path ?? "");
      if (!ALLOWED.some((re) => re.test(path))) return json({ error: "Percorso non consentito" }, 400);
      return json(await get(path, input.params ?? {}));
    }
    if (input.action === "search") return json(await searchPatients(input.params ?? {}));
    if (input.action === "patient") return json(await patientDetail(Number(input.params?.patientId)));
    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    if (e instanceof AlfaError) return json({ error: "Errore AlfaDocs", status: e.status, body: e.body }, 502);
    return json({ error: "AlfaDocs non raggiungibile" }, 502);
  }
});
