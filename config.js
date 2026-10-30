/* Koneksi database Supabase.
   supabaseKey = Publishable key (sb_publishable_…) atau anon public key. Kunci ini memang aman di frontend:
   akses data dibatasi aturan Row Level Security di database. JANGAN menaruh secret / service_role key di sini.
   loginDomain harus sama dengan public.login_domain() di supabase/schema.sql. */
window.ADC_CONFIG = {
  supabaseUrl: "postgresql://postgres.wiwtdtuuifgqcapdbxbz:WDSRUQstJzXcb8qt@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
  supabaseKey: "sb_publishable__Bclg32ZlGD5lh6B2Z0uRw_E0OIgq_a",
  loginDomain: "dataset-collector.app"
};
