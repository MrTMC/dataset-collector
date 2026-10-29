# Dataset Collector

Aplikasi web untuk mengumpulkan dataset citra sampah. Pengguna mengambil foto, mendapat saran kategori dari AI lokal, lalu nama berkas dibuat otomatis sesuai standar PRD. Foto dikelompokkan per objek fisik dan bisa diekspor dengan pembagian train/val/test per objek.

- **Login dengan username.** Akun pertama menjadi admin. Akun lain hanya dibuat admin, tidak ada pendaftaran bebas.
- **Peran:** pengumpul, pemeriksa, dan admin. Aturannya ditegakkan di database (Row Level Security dan fungsi server).
- **Database bersama** (PostgreSQL Supabase), tersinkron antar-perangkat.
- **Penomoran di server.** ID objek dan ulangan ditetapkan dalam satu transaksi, jadi dua HP tidak pernah mendapat nomor yang sama.
- **Kode fotografer** melekat pada akun dan otomatis masuk ke nama berkas.
- **AI lokal gratis** (ONNX Runtime Web + model `waste5-v1`). Foto tidak dikirim ke layanan AI. Lihat [MODEL_CARD.md](MODEL_CARD.md).

Format nama berkas: `<kelas>_<lokasi>_<cahaya>_<YYYYMMDD>_<fotografer>_<idobjek>_<ulangan>.jpg`, misalnya `plastik_kantin_in_20261029_FA01_0007_2.jpg`.

## Pemasangan

1. **Supabase**: buat proyek gratis, buka **SQL Editor → New query**, tempel isi `supabase/schema.sql`, lalu klik **Run**. Skrip ini aman dijalankan ulang.
2. **Matikan pendaftaran bebas**: buka **Authentication → Sign In / Providers**, lalu matikan **Allow new users to sign up**. Akun dibuat oleh fungsi database, jadi pengaturan ini tidak memengaruhi admin.
3. **config.js**: isi `supabaseUrl` dan `supabaseKey` (publishable atau anon key). Jangan pernah memakai *secret* atau *service_role key*.
4. **GitHub Pages**: buka **Settings → Pages → Deploy from a branch → `main` / root**.
5. **Buka alamat situs**. Layar pertama meminta pembuatan akun admin. Lakukan segera setelah situs aktif, karena siapa pun yang membuka situs pertama kali bisa mengisi layar ini.

## Peran

| Peran | Bisa |
|---|---|
| Pengumpul | ambil dan simpan foto, lihat galeri, ekspor |
| Pemeriksa | + verifikasi, koreksi kategori objek, hapus foto |
| Admin | + pengaturan proyek, tambah/ubah/nonaktifkan/hapus pengguna, atur ulang kata sandi |

Admin membuat akun di **Pengaturan → Pengguna**, lalu membagikan info masuk lewat tombol **Salin info masuk**. Pengguna bisa mengganti kata sandinya di **Pengaturan → Akun saya**. Jika lupa kata sandi, admin mengaturnya ulang.

## Catatan teknis

- Username disimpan di Supabase Auth sebagai `username@dataset-collector.app`. Alamat ini tidak pernah dipakai mengirim email. Jika diubah, samakan `loginDomain` di `config.js` dengan `public.login_domain()` di `schema.sql`.
- Akun dibuat langsung di tabel `auth.users` oleh fungsi `security definer`, dengan kolom token diisi string kosong (bukan NULL) agar login berfungsi.
- Kamera langsung butuh HTTPS. GitHub Pages sudah memakai HTTPS. Jika izin kamera ditolak, aplikasi menawarkan aplikasi kamera bawaan perangkat atau galeri.
- Menyimpan foto butuh internet. Kamera dan AI lokal tetap berjalan tanpa sinyal.

## Batas paket gratis Supabase

Database 500 MB, penyimpanan berkas 1 GB, dan 50.000 pengguna aktif per bulan. Foto 1600 px (JPEG 90%) berukuran ±300–500 KB, jadi 1 GB cukup untuk ±2.000–3.000 foto. Proyek gratis dijeda setelah 1 minggu tidak dipakai dan bisa diaktifkan lagi dari dasbor Supabase. Unduh ZIP dataset secara berkala sebagai cadangan.

Lisensi komponen: ONNX Runtime Web (MIT), supabase-js (MIT), JSZip (MIT/GPLv3), bobot model (Apache-2.0), data latih AlphaTrash & TrashNet (MIT).
