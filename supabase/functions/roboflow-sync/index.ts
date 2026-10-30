// Edge Function: roboflow-sync
// Mengirim foto yang sudah diverifikasi ke proyek Roboflow tim, lalu mencatat statusnya di tabel images.
//
// Dipanggil aplikasi setelah tombol Verifikasi ditekan:
//   POST /functions/v1/roboflow-sync   { "project_id": "<uuid>", "image_ids": ["..."] }
//   (tanpa image_ids → mengirim foto terverifikasi yang belum terkirim, maksimal 20 per panggilan)
//
// Keamanan:
// • Hanya pengguna yang login (JWT) dan anggota proyek yang bisa memicu kiriman. Foto & proyek dibaca dengan
//   token pengguna sehingga Row Level Security menentukan apa yang boleh dikirim.
// • Kunci API Roboflow tidak pernah dikirim ke browser. Disimpan di tabel project_secrets (diatur admin dari
//   aplikasi) atau secret ROBOFLOW_API_KEY di Supabase → Edge Functions → Secrets.

type Env = { url: string; pub: string; secret: string; rfKey?: string };
type Fetch = typeof fetch;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_PER_CALL = 20;
const RF_API = "https://api.roboflow.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function pickKey(jsonVar: string | undefined, legacy: string | undefined) {
  if (jsonVar) {
    try { const j = JSON.parse(jsonVar); const v = j.default ?? Object.values(j)[0]; if (v) return String(v); } catch { /* bukan JSON */ }
  }
  return legacy || "";
}
export function envFromDeno(get: (k: string) => string | undefined): Env {
  return {
    url: (get("SUPABASE_URL") || "").replace(/\/$/, ""),
    pub: pickKey(get("SUPABASE_PUBLISHABLE_KEYS"), get("SUPABASE_ANON_KEY")),
    secret: pickKey(get("SUPABASE_SECRET_KEYS"), get("SUPABASE_SERVICE_ROLE_KEY")),
    rfKey: get("ROBOFLOW_API_KEY") || undefined,
  };
}
// Secret key baru (sb_secret_…) hanya boleh di header apikey; service_role lama (JWT) juga di Authorization.
function serviceHeaders(env: Env): Record<string, string> {
  return env.secret.startsWith("sb_secret_") ? { apikey: env.secret } : { apikey: env.secret, Authorization: "Bearer " + env.secret };
}
// "workspace/proyek", URL app.roboflow.com, atau slug → slug proyek
export function projectSlug(s: string) {
  const t = String(s || "").trim().replace(/^https?:\/\/[^/]+\//, "").replace(/[?#].*$/, "");
  const parts = t.split("/").filter(Boolean);
  const slug = parts.length >= 2 ? parts[1] : parts[0] || "";
  return /^[a-z0-9][a-z0-9._-]*$/i.test(slug) ? slug.toLowerCase() : "";
}
function fnv(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// split "auto": satu objek fisik selalu masuk split yang sama (tidak bocor antar train/valid/test)
export function splitFor(mode: string, projectId: string, groupId: string, ratio = { train: 70, valid: 20, test: 10 }) {
  if (mode === "train" || mode === "valid" || mode === "test") return mode;
  const tot = (ratio.train + ratio.valid + ratio.test) || 100;
  const x = (fnv(projectId + ":" + groupId) % 10000) / 10000 * tot;
  return x < ratio.train ? "train" : x < ratio.train + ratio.valid ? "valid" : "test";
}
const inList = (ids: string[]) => "(" + ids.map(i => '"' + String(i).replace(/["\\]/g, "") + '"').join(",") + ")";

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Gunakan POST." }, 405);
  if (!env.url || !env.pub || !env.secret) return json({ error: "Edge Function belum punya SUPABASE_URL / kunci proyek." }, 500);
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/.test(auth)) return json({ error: "Harus login." }, 401);
  let body: { project_id?: string; image_ids?: string[] };
  try { body = await req.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
  const pid = String(body.project_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(pid)) return json({ error: "project_id tidak valid." }, 400);
  const ids = Array.isArray(body.image_ids) ? body.image_ids.map(String).slice(0, 200) : null;

  const asUser = { apikey: env.pub, Authorization: auth };
  const svc = serviceHeaders(env);
  const rest = env.url + "/rest/v1";

  // 1. Proyek harus terlihat oleh pengguna (anggota atau admin) — diperiksa RLS.
  const pr = await f(`${rest}/projects?select=id,data&id=eq.${pid}`, { headers: asUser });
  if (pr.status === 401) return json({ error: "Sesi login tidak valid." }, 401);
  const prj = pr.ok ? (await pr.json())[0] : null;
  if (!prj) return json({ error: "Anda bukan anggota proyek ini." }, 403);
  const rf = (prj.data && prj.data.roboflow) || {};
  if (!rf.enabled) return json({ error: "Kirim ke Roboflow belum diaktifkan untuk proyek ini." }, 409);
  const slug = projectSlug(rf.project);
  if (!slug) return json({ error: "Nama proyek Roboflow belum diisi." }, 409);

  // 2. Kunci API: tabel project_secrets (service), lalu secret ROBOFLOW_API_KEY.
  const sr = await f(`${rest}/project_secrets?select=roboflow_api_key&project_id=eq.${pid}`, { headers: svc });
  const apiKey = (sr.ok && ((await sr.json())[0] || {}).roboflow_api_key) || env.rfKey;
  if (!apiKey) return json({ error: "Kunci API Roboflow belum diatur admin." }, 409);

  // 3. Foto terverifikasi yang boleh dilihat pengguna.
  let q = `${rest}/images?select=id,group_id,filename,verification_status,data,roboflow_status&project_id=eq.${pid}&verification_status=eq.verified&order=created_at`;
  if (ids) { if (!ids.length) return json({ sent: 0, duplicate: 0, failed: 0, remaining: 0, results: [] }); q += "&id=in." + inList(ids); }
  else q += "&or=(roboflow_status.is.null,roboflow_status.eq.error)";
  const ir = await f(q, { headers: asUser });
  if (!ir.ok) return json({ error: "Gagal membaca foto: " + (await ir.text()).slice(0, 200) }, 502);
  const all = (await ir.json()) as any[];
  const todo = all.filter(r => r.roboflow_status !== "done" && r.roboflow_status !== "duplicate");
  const batch = todo.slice(0, MAX_PER_CALL);

  const results: any[] = [];
  const patch = (id: string, fields: Record<string, unknown>) =>
    f(`${rest}/images?project_id=eq.${pid}&id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(fields),
    });

  for (const r of batch) {
    const at = new Date().toISOString();
    try {
      const asset = r.data && r.data.asset_id;
      if (!asset) throw new Error("berkas foto tidak ditemukan");
      const br = await f(`${env.url}/storage/v1/object/photos/${asset.split("/").map(encodeURIComponent).join("/")}`, { headers: svc });
      if (!br.ok) throw new Error("gagal mengambil foto dari penyimpanan (" + br.status + ")");
      const blob = await br.blob();
      const split = splitFor(rf.split || "auto", pid, r.group_id);
      const qs = new URLSearchParams({ api_key: apiKey, name: r.filename, split });
      if (rf.batch) qs.set("batch", String(rf.batch).slice(0, 64));
      const cat = r.data && r.data.category_confirmed;
      if (cat && rf.tag !== false) qs.append("tag", cat);
      const fd = new FormData();
      fd.append("name", r.filename);
      fd.append("split", split);
      fd.append("file", new File([blob], r.filename, { type: "image/jpeg" }));
      const up = await f(`${RF_API}/dataset/${slug}/upload?${qs}`, { method: "POST", body: fd });
      const txt = await up.text();
      let out: any = {}; try { out = JSON.parse(txt); } catch { /* bukan JSON */ }
      if (!up.ok || out.success === false || out.error) {
        const m = (out.error && (out.error.message || out.error)) || out.message || txt || ("HTTP " + up.status);
        throw new Error("Roboflow: " + String(m).slice(0, 240));
      }
      const status = out.duplicate ? "duplicate" : "done";
      await patch(r.id, { roboflow_status: status, roboflow_id: out.id ? String(out.id) : null, roboflow_error: null, roboflow_at: at });
      results.push({ id: r.id, filename: r.filename, status, split, roboflow_id: out.id || null });
    } catch (e) {
      const msg = String((e as Error).message || e).replace(apiKey, "***").slice(0, 300);
      await patch(r.id, { roboflow_status: "error", roboflow_error: msg, roboflow_at: at }).catch(() => {});
      results.push({ id: r.id, filename: r.filename, status: "error", error: msg });
    }
  }
  return json({
    sent: results.filter(x => x.status === "done").length,
    duplicate: results.filter(x => x.status === "duplicate").length,
    failed: results.filter(x => x.status === "error").length,
    remaining: todo.length - batch.length,
    results,
  });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && typeof D.serve === "function") D.serve((req: Request) => handle(req, envFromDeno(k => D.env.get(k))));
