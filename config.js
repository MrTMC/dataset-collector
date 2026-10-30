/* Koneksi database Supabase.
   supabaseKey = Publishable key (sb_publishable_…) atau anon public key. Kunci ini memang aman di frontend:
   akses data dibatasi aturan Row Level Security di database. JANGAN menaruh secret / service_role key di sini.
   loginDomain harus sama dengan public.login_domain() di supabase/schema.sql. */
window.ADC_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
  loginDomain: "dataset-collector.app"
};
