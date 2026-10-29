# Model waste5-v1 — Klasifikasi Sampah 5 Kelas

| Item | Nilai |
|---|---|
| Kelas | organik, kertas, plastik, logam, residu |
| Arsitektur | MobileNetV3-Large 1.0, pretrain ImageNet-21K (beku) + kepala regresi logistik 5 kelas |
| Berkas | `models/waste5-v1.onnx`, 8,1 MB (bobot float16, dihitung float32) |
| Runtime | ONNX Runtime Web 1.30.0, WebAssembly SIMD, 1 thread (`ort-wasm-simd-threaded.wasm`, 13,6 MB) |
| Total unduhan pertama | ±21,6 MB (artifact: ±24,3 MB karena model dikirim sebagai base64) |
| Input | RGB 0–255, sisi pendek 256 px lalu potong tengah 224×224 |
| Output | `probs` [1,5] dan `embedding` [1,1280] untuk adaptasi k-NN dari foto terverifikasi |
| Lisensi | Bobot backbone timm `mobilenetv3_large_100.miil_in21k` (Apache-2.0) via ONNX Model Zoo (Apache-2.0); data latih AlphaTrash (MIT) dan TrashNet (MIT); ONNX Runtime Web (MIT) |

## Data uji

- **AlphaTrash** — 5.691 foto dari Thailand, kamera di dalam kompartemen tempat sampah; kelas general/metal/organic/paper/plastic dipetakan ke residu/logam/organik/kertas/plastik.
- **TrashNet** — 2.026 foto latar putih (tanpa kelas kaca); paper+cardboard → kertas, trash → residu.
- Foto hampir-duplikat dikelompokkan (dHash ≤ 3 atau kemiripan fitur ≥ 0,92 dalam kelas yang sama) sebelum pembagian data, sehingga foto mirip tidak tersebar ke data latih dan data uji. AlphaTrash: 5.691 foto → 2.870 grup.

## Kandidat yang diuji (fitur beku + regresi logistik)

| Model | Akurasi uji gabungan | AlphaTrash (grup) | Lintas dataset | +10 foto/kelas | Latensi CPU 1 thread |
|---|---|---|---|---|---|
| **MobileNetV3-L (IN-21K)** | **91,1%** | 93,4% | **50,0%** | **62,1%** | **7,2 ms** |
| EfficientNet-B0 | 91,4% | 93,1% | 48,2% | 59,1% | 16,3 ms |
| LCNet-100 | 90,2% | 92,9% | 38,9% | 48,2% | 5,0 ms |
| MobileNetV3-L (IN-1K) | 90,1% | 94,1% | 42,3% | 52,4% | 7,0 ms |
| GhostNet-100 | 89,4% | 92,8% | 39,4% | 52,4% | 9,8 ms |
| RegNetX-002 | 85,8% | 88,7% | 31,1% | 38,9% | 8,3 ms |
| ResNet-18 | 85,9% | 89,4% | 31,9% | 40,9% | 31,5 ms |
| MobileViTv2-050 | 82,3% | 85,2% | 49,6% | 59,0% | 13,4 ms |

Lintas dataset = latih pada AlphaTrash, uji pada TrashNet (4 kelas). "+10 foto/kelas" = sama, ditambah adaptasi k-NN dari 10 foto berlabel per kelas, mensimulasikan aplikasi belajar dari foto terverifikasi.

## Model terpilih

Akurasi berkas ONNX final pada 949 foto uji dari grup yang tidak pernah dilihat saat pelatihan: **90,1%** (fp32 90,0%; bobot float16 90,1%). Recall per kelas pada set uji yang sama (evaluasi scikit-learn, 91,1%): organik 98,5%, kertas 93,3%, plastik 89,8%, logam 92,5%, residu 84,6%. Kesalahan terbanyak: residu ↔ kertas/plastik, plastik ↔ logam.

Kuantisasi: int8 penuh (statis/dinamis) menurunkan akurasi ke 40%/26%, int8 bobot saja 88,7% (4,2 MB). Float16 dipilih karena tanpa kehilangan akurasi.

Waktu inferensi: 6,9 ms (ONNX Runtime CPU) dan 41 ms (ONNX Runtime Web WebAssembly) per foto di CPU server uji, 1 thread. Keluaran ONNX Runtime Web identik dengan Python (selisih probabilitas maks 3×10⁻⁶).

## Keterbatasan

1. Kelas organik hanya berasal dari AlphaTrash, jadi keragamannya terbatas.
2. Akurasi turun tajam pada foto dengan latar dan kamera berbeda (50% lintas dataset). Aplikasi memakai foto terverifikasi proyek untuk adaptasi k-NN, dan menampilkan akurasi nyata di proyek (prediksi AI vs label final).
3. Kaca bukan kelas; foto kaca cenderung diprediksi plastik atau logam.
4. Model belum diuji pada foto lapangan kampus di Indonesia. Ukur ulang setelah terkumpul ±50 foto terverifikasi per kelas.
5. Prapemrosesan di browser memakai resize canvas, bukan bicubic PIL; perbedaan kecil pada probabilitas bisa terjadi.
