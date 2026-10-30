# Dataset Collector

Aplikasi web untuk mengumpulkan dataset citra sampah. Alurnya:

1. Pengguna mengambil foto.
2. Objek dipotong otomatis sehingga hanya objek yang disimpan.
3. AI lokal memberi saran kategori.
4. Nama berkas dibuat otomatis sesuai standar PRD.
5. Setelah diverifikasi, foto dan namanya bisa langsung dikirim ke proyek Roboflow tim.

Fitur utama:

- **Login dengan username.** Akun pertama menjadi admin. Akun lain hanya dibuat oleh admin.
- **Dua peran.** Admin menambah anggota dan mengatur proyek. Anggota mengambil foto dan memverifikasi.
- **Proyek terkunci per anggota.** Anggota hanya bisa membuka proyek yang diberikan admin. Aturan ini ditegakkan di database (Row Level Security), termasuk untuk berkas foto.
- **ID objek otomatis atau diketik sendiri.** Nomor ditetapkan di server dalam satu transaksi, sehingga dua HP tidak pernah mendapat nomor yang sama.
- **Potong objek otomatis** dengan model U²-Net-p di perangkat. Kotak potong bisa digeser atau diubah ukurannya.
- **AI lokal gratis** (ONNX Runtime Web dan model `waste5-v1`). Foto tidak dikirim ke layanan AI. Lihat [MODEL_CARD.md](MODEL_CARD.md).
- **Kirim ke Roboflow** saat tombol Verifikasi ditekan, lewat Edge Function. Kunci API tidak pernah sampai ke browser.

Format nama berkas: `<kelas>_<lokasi>_<cahaya>_<YYYYMMDD>_<fotografer>_<idobjek>_<ulangan>.jpg`, misalnya `plastik_kantin_in_20261029_FA01_0007_2.jpg`.

## Pemasangan baru

1. **Supabase.** Buka **SQL Editor → New query**, tempel seluruh isi `supabase/schema.sql`, lalu klik **Run**.
2. **Matikan pendaftaran bebas.** Buka **Authentication → Sign In / Providers**, lalu matikan **Allow new users to sign up**.
3. **config.js.** Isi `supabaseUrl` (Project URL `https://xxxx.supabase.co`) dan `supabaseKey` (Publishable key). Jangan memakai secret key atau service_role key.
4. **Hosting.** Pakai Vercel (**Add New → Project → Framework: Other → Deploy**) atau GitHub Pages.
5. **Buka situs** dan buat akun admin.
6. **Roboflow (opsional).** Lihat bagian di bawah.

## Memperbarui dari versi sebelumnya (v2 → v3)

1. Unggah semua berkas baru ke GitHub, termasuk `models/u2netp.onnx` (4,4 MB). Vercel akan memperbarui situs otomatis.
2. Jalankan ulang seluruh isi `supabase/schema.sql` di **SQL Editor**. Skrip ini aman dijalankan di atas v2:
   - Data, foto, dan akun tetap.
   - Peran lama *pengumpul* dan *pemeriksa* otomatis menjadi **anggota**.
3. **Penting:** setelah pembaruan, anggota lama belum punya akses ke proyek mana pun. Admin perlu mencentang mereka di **Pengaturan → Proyek → Anggota proyek**, atau di **Pengaturan → Pengguna → Ubah → Akses proyek**.

## Peran

| Peran | Bisa |
|---|---|
| Anggota | membuka proyek yang diberikan admin, ambil dan simpan foto, verifikasi, koreksi kategori, ekspor |
| Admin | semua proyek, membuat dan mengatur proyek, menambah/mengubah/menonaktifkan anggota, mengatur akses proyek, menghapus foto, mengatur Roboflow |

## Kirim otomatis ke Roboflow

Saat anggota menekan **Verifikasi**, aplikasi memanggil Edge Function `roboflow-sync`. Fungsi ini:

1. Memeriksa bahwa pengguna adalah anggota proyek.
2. Mengambil foto (yang sudah dipotong) dari penyimpanan.
3. Mengunggahnya ke Roboflow dengan nama berkas yang sama.
4. Mencatat statusnya di tabel `images` (`roboflow_status`, `roboflow_id`, `roboflow_error`).

**Pasang sekali:**

1. Di Supabase, buka **Edge Functions → Deploy a new function → Via Editor**.
2. Beri nama fungsi persis `roboflow-sync`.
3. Hapus contoh kode, tempel seluruh isi `supabase/functions/roboflow-sync/index.ts`, lalu klik **Deploy function**.
4. Biarkan **Verify JWT** tetap aktif.

Pengganti langkah di atas lewat CLI: `supabase functions deploy roboflow-sync`.

**Atur di aplikasi** (login sebagai admin): buka **Pengaturan → Proyek → Kirim ke Roboflow**, lalu:

1. Isi **Proyek Roboflow**: slug proyek, atau tempel tautan proyek dari app.roboflow.com.
2. Centang **Kirim otomatis setelah verifikasi**.
3. Tempel **Private API Key**, ambil dari Roboflow → Settings → API Keys, lalu klik **Simpan kunci**.
   - Kunci disimpan di tabel `project_secrets`, yang tidak bisa dibaca siapa pun dari aplikasi.
   - Sebagai alternatif, simpan kunci sebagai secret `ROBOFLOW_API_KEY` di **Edge Functions → Secrets**.
4. Pilih split:
   - **Otomatis per objek** (70/20/10) menaruh semua foto dari satu ID objek di split yang sama, sehingga train dan test tidak bocor.
   - Pilih *train* bila pembagian akan dilakukan di Roboflow.
5. Foto yang sudah terverifikasi sebelumnya bisa dikirim dengan tombol **Kirim … foto terverifikasi yang belum terkirim**.

Perilaku lain:

- Foto yang identik di Roboflow ditandai *sudah ada*.
- Membatalkan verifikasi tidak menghapus foto dari Roboflow.
- Foto yang gagal terkirim bisa dikirim ulang dari detail foto di Galeri.

## Potong objek otomatis

Proses pemotongan:

- Model U²-Net-p (4,4 MB, Apache-2.0) mencari objek utama, lalu kotak potong ditempatkan di sekelilingnya dengan sedikit margin.
- Jika model tidak yakin, misalnya karena objek kecil di latar ramai, foto disimpan utuh dan anggota diminta menarik sudut kotak.
- Hanya bagian di dalam kotak yang disimpan.
- Metadata mencatat `crop_source`, `crop_box`, dan ukuran foto asli.

Model diunduh sekali bersama model kategori, dengan tombol **Unduh model** (±27 MB total termasuk runtime). Admin bisa mematikan potong otomatis per proyek di **Pengaturan → Proyek → Gambar**.

## ID objek

| Pilihan | Hasil |
|---|---|
| **Objek baru** | ID berikutnya otomatis (0001, 0002, …) |
| **Ketik ID objek sendiri** | ID yang belum ada menjadi objek baru dengan ID itu. ID yang sudah ada disimpan sebagai ulangan berikutnya dari objek tersebut. Penomoran otomatis selanjutnya melanjutkan dari ID terbesar. |
| **Foto ulang objek** | pilih objek dari daftar |

## Catatan teknis

- Username disimpan di Supabase Auth sebagai `username@dataset-collector.app`. Alamat ini tidak pernah dipakai mengirim email.
- Kamera langsung butuh HTTPS. Menyimpan foto butuh internet. Kamera, potong objek, dan AI lokal tetap berjalan tanpa sinyal setelah model terunduh.
- Batas paket gratis Supabase:
  - Database 500 MB dan penyimpanan berkas 1 GB, cukup untuk ±3.000–5.000 foto yang sudah dipotong.
  - Edge Functions 500.000 panggilan per bulan.
- GitHub (unggah lewat web) membatasi 25 MB per berkas. Berkas terbesar adalah `ort/ort-wasm-simd-threaded.wasm` (13,6 MB), jadi masih di bawah batas.

Lisensi komponen: ONNX Runtime Web (MIT), supabase-js (MIT), JSZip (MIT/GPLv3), bobot model kategori (Apache-2.0), U²-Net-p (Apache-2.0), data latih AlphaTrash dan TrashNet (MIT).
