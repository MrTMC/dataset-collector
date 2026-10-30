// Edge Function: roboflow-sync
// Proyek klasifikasi → foto terpotong + label kelas. Proyek deteksi objek → foto utuh + kotak objek (Pascal VOC).
// Mengirim foto yang sudah diverifikasi ke proyek Roboflow tim, memberi label kelasnya (proyek klasifikasi →
// langsung masuk Dataset), lalu mencatat statusnya di tabel images.
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
// Workspace pemilik kunci API (Roboflow mengembalikan {"workspace": "<url>"} dari POST /?api_key=).
async function keyWorkspace(f: Fetch, apiKey: string): Promise<string> {
  for (const method of ["POST", "GET"]) {
    try {
      const r = await f(`${RF_API}/?api_key=${encodeURIComponent(apiKey)}`, { method });
      const j: any = await r.json().catch(() => ({}));
      const ws = typeof j.workspace === "string" ? j.workspace : j.workspace && (j.workspace.url || j.workspace.id);
      if (r.ok && ws) return String(ws);
    } catch { /* coba metode lain */ }
  }
  return "";
}
// Tipe proyek Roboflow: "classification", "object-detection", … ("" bila tidak diketahui)
export async function projectType(f: Fetch, apiKey: string, slug: string): Promise<string> {
  try {
    const ws = await keyWorkspace(f, apiKey);if (!ws) return "";
    const r = await f(`${RF_API}/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}?api_key=${encodeURIComponent(apiKey)}`);
    const j: any = await r.json().catch(() => ({}));
    return String((j.project && j.project.type) || "");
  } catch { return ""; }
}
// Proyek klasifikasi: beri label kelas → foto langsung masuk Dataset (bukan antrean Annotate).
export async function labelClassification(f: Fetch, apiKey: string, slug: string, imageId: string, label: string): Promise<string | null> {
  const qs = new URLSearchParams({ api_key: apiKey, name: label, addToDataset: "true" });
  const r = await f(`${RF_API}/dataset/${slug}/annotate/${encodeURIComponent(imageId)}?${qs}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ annotationFile: label, labelmap: null }),
  });
  const j: any = await r.json().catch(() => ({}));
  const msg = String((j.error && (j.error.message || j.error)) || j.message || "");
  if (r.status === 409 && /already annotated/i.test(msg)) return null;
  if (!r.ok || j.error || j.success === false) return msg || ("HTTP " + r.status);
  return null;
}
// Pascal VOC untuk satu objek; kotak relatif (0..1) → piksel.
export function vocXml(filename: string, W: number, H: number, label: string, b: { x: number; y: number; w: number; h: number }) {
  const cl = (v: number, m: number) => Math.max(0, Math.min(m, Math.round(v)));
  const esc = (t: string) => t.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" } as any)[c]);
  const x0 = cl(b.x * W, W - 1), y0 = cl(b.y * H, H - 1), x1 = Math.max(x0 + 1, cl((b.x + b.w) * W, W)), y1 = Math.max(y0 + 1, cl((b.y + b.h) * H, H));
  return `<annotation><folder></folder><filename>${esc(filename)}</filename><size><width>${W}</width><height>${H}</height><depth>3</depth></size><segmented>0</segmented>` +
    `<object><name>${esc(label)}</name><pose>Unspecified</pose><truncated>0</truncated><difficult>0</difficult><occluded>0</occluded>` +
    `<bndbox><xmin>${x0}</xmin><ymin>${y0}</ymin><xmax>${x1}</xmax><ymax>${y1}</ymax></bndbox></object></annotation>`;
}
export async function labelDetection(f: Fetch, apiKey: string, slug: string, imageId: string, filename: string, W: number, H: number, label: string, box: { x: number; y: number; w: number; h: number }): Promise<string | null> {
  const name = filename.replace(/\.jpe?g$/i, "") + ".xml";
  const qs = new URLSearchParams({ api_key: apiKey, name, addToDataset: "true" });
  const r = await f(`${RF_API}/dataset/${slug}/annotate/${encodeURIComponent(imageId)}?${qs}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ annotationFile: vocXml(filename, W, H, label, box), labelmap: null }),
  });
  const j: any = await r.json().catch(() => ({}));
  const msg = String((j.error && (j.error.message || j.error)) || j.message || "");
  if (r.status === 409 && /already annotated/i.test(msg)) return null;
  if (!r.ok || j.error || j.success === false) return msg || ("HTTP " + r.status);
  return null;
}
// Jelaskan kegagalan "does not exist / missing permissions": kunci milik workspace mana, proyek apa saja yang ada di sana.
export async function diagnoseRoboflow(f: Fetch, apiKey: string, slug: string): Promise<string> {
  try {
    const ws = await keyWorkspace(f, apiKey);
    if (!ws) return "Kunci API ditolak Roboflow. Pastikan yang ditempel adalah Private API Key (bukan Publishable key yang diawali rf_).";
    const w = await f(`${RF_API}/${encodeURIComponent(ws)}?api_key=${encodeURIComponent(apiKey)}`);
    const wj: any = await w.json().catch(() => ({}));
    const ps: string[] = ((wj.workspace && wj.workspace.projects) || []).map((p: any) => String(p.id || "").split("/").pop()).filter(Boolean);
    if (ps.includes(slug)) return `Proyek "${slug}" ada di workspace "${ws}", tetapi kunci ini tidak boleh mengunggah ke sana. Periksa peran akun di workspace tersebut.`;
    return `Proyek "${slug}" tidak ditemukan di workspace "${ws}" (workspace pemilik kunci API ini). ` +
      (ps.length ? `Proyek yang ada: ${ps.slice(0, 12).join(", ")}. ` : "Workspace ini belum punya proyek. ") +
      "Isi nama proyek persis seperti di alamat app.roboflow.com/<workspace>/<proyek>, dan ambil Private API Key saat workspace tim yang dipilih.";
  } catch { return ""; }
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
  // "uploaded" (terunggah tanpa label) hanya dikirim ulang bila diminta per foto
  const todo = all.filter(r => !["done", "duplicate"].includes(r.roboflow_status) && (ids || r.roboflow_status !== "uploaded"));
  const batch = todo.slice(0, MAX_PER_CALL);

  const results: any[] = [];
  let diag: string | null = null;
  let ptype: string | null = null; // dicari sekali per panggilan
  const patch = (id: string, fields: Record<string, unknown>) =>
    f(`${rest}/images?project_id=eq.${pid}&id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(fields),
    });

  for (const r of batch) {
    const at = new Date().toISOString();
    try {
      const d = r.data || {};
      const cat = d.category_confirmed;
      if (!d.asset_id) throw new Error("berkas foto tidak ditemukan");
      if (rf.label !== false && cat && ptype === null) ptype = await projectType(f, apiKey, slug);
      const detection = !!ptype && ptype !== "classification";
      // Proyek deteksi objek: kirim foto utuh + kotak objek. Foto asli disimpan saat foto dipotong (source_asset_id);
      // foto yang tidak dipotong sudah utuh, kotaknya relatif terhadap foto itu sendiri.
      const ob = d.object_box && d.object_box.w > 0 ? d.object_box : null;
      let assetPath = d.asset_id, W = +d.width || 0, H = +d.height || 0, box = null as null | { x: number; y: number; w: number; h: number };
      if (detection && ob) {
        if (d.crop_box && d.source_asset_id) { assetPath = d.source_asset_id; W = +d.source_width || 0; H = +d.source_height || 0; box = ob; }
        else if (!d.crop_box) box = ob;
      }
      const br = await f(`${env.url}/storage/v1/object/photos/${assetPath.split("/").map(encodeURIComponent).join("/")}`, { headers: svc });
      if (!br.ok) throw new Error("gagal mengambil foto dari penyimpanan (" + br.status + ")");
      const blob = await br.blob();
      const split = splitFor(rf.split || "auto", pid, r.group_id);
      const qs = new URLSearchParams({ api_key: apiKey, name: r.filename, split });
      if (rf.batch) qs.set("batch", String(rf.batch).slice(0, 64));
      if (cat && rf.tag !== false) qs.append("tag", cat);
      const fd = new FormData();
      fd.append("name", r.filename);
      fd.append("split", split);
      fd.append("file", new File([blob], r.filename, { type: "image/jpeg" }));
      const up = await f(`${RF_API}/dataset/${slug}/upload?${qs}`, { method: "POST", body: fd });
      const txt = await up.text();
      let out: any = {}; try { out = JSON.parse(txt); } catch { /* bukan JSON */ }
      if (!up.ok || out.success === false || out.error) {
        const m = String((out.error && (out.error.message || out.error)) || out.message || txt || ("HTTP " + up.status));
        if (/does not exist|missing permission|unsupported request|unauthori|forbidden/i.test(m) || up.status === 401 || up.status === 403 || up.status === 404) {
          if (diag === null) diag = await diagnoseRoboflow(f, apiKey, slug);
          if (diag) throw new Error(diag);
        }
        throw new Error("Roboflow: " + m.slice(0, 240));
      }
      // Label → foto langsung masuk Dataset. Klasifikasi: nama kelas. Deteksi objek: kotak (Pascal VOC).
      let status = out.duplicate ? "duplicate" : "done", note: string | null = null;
      if (rf.label !== false && cat && out.id) {
        let err: string | null = null;
        if (!detection) err = await labelClassification(f, apiKey, slug, String(out.id), cat);
        else if (box && W && H) err = await labelDetection(f, apiKey, slug, String(out.id), r.filename, W, H, cat, box);
        else { status = "uploaded"; note = `Proyek Roboflow bertipe ${ptype}, tetapi foto ini tidak punya kotak objek (dipotong otomatis ragu atau foto lama). Atur kotak di Roboflow → Annotate.`; }
        if (err) { status = "uploaded"; note = (ptype ? "" : "Tipe proyek tidak terbaca. ") + "Terunggah, tetapi label gagal dipasang: " + err.slice(0, 200); }
      } else if (!out.duplicate) { status = "uploaded"; }
      await patch(r.id, { roboflow_status: status, roboflow_id: out.id ? String(out.id) : null, roboflow_error: note, roboflow_at: at });
      results.push({ id: r.id, filename: r.filename, status, split, roboflow_id: out.id || null, note });
    } catch (e) {
      const msg = String((e as Error).message || e).replace(apiKey, "***").slice(0, 300);
      await patch(r.id, { roboflow_status: "error", roboflow_error: msg, roboflow_at: at }).catch(() => {});
      results.push({ id: r.id, filename: r.filename, status: "error", error: msg });
    }
  }
  return json({
    sent: results.filter(x => x.status === "done").length,
    unlabeled: results.filter(x => x.status === "uploaded").length,
    duplicate: results.filter(x => x.status === "duplicate").length,
    failed: results.filter(x => x.status === "error").length,
    remaining: todo.length - batch.length,
    results,
  });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && typeof D.serve === "function") D.serve((req: Request) => handle(req, envFromDeno(k => D.env.get(k))));
