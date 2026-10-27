# Configuration and deployment

Semua konfigurasi runtime berasal dari `.env` pada root project. Loader terpusat (`apps/api/src/config.ts`) mencari file berdasarkan lokasi aplikasi, bukan working directory. File wajib ada; jika belum ada, startup memberi instruksi menyalin `.env.example`. Nilai shell tidak menggantikan konfigurasi aplikasi. Build tidak membutuhkan kredensial runtime.

## Variabel root .env

| Variabel | Nilai / cara mengubah |
| --- | --- |
| `APP_MODE` | Wajib `native` atau `docker`. Pilih sebelum menjalankan command; `npm start` hanya native, startup container hanya docker. |
| `APP_PORT` | Default `3000`; angka integer 1–65535. Dipakai listener, pemetaan port Compose, dan healthcheck. |
| `NODE_ENV` | `production` (default), `development`, atau `test`. Production mewajibkan kunci enkripsi dan melarang demo seed. |
| `APP_NAME` | Default `Hotel Operations`; 1–120 karakter tanpa karakter kontrol. Nama pada status startup, tidak mengganti branding tenant. |
| `APP_URL` | Wajib origin HTTP(S) persis, misalnya `http://localhost:3000`; tanpa path, kredensial, query, atau trailing slash. Ubah bersama port lokal; URL publik dapat memakai port reverse proxy yang berbeda. |
| `DB_TYPE` | `embedded` (default native) atau `postgres`. Docker wajib postgres. |
| `DB_FILE` | Default `./data/app.db`; direktori PGlite persisten, relatif terhadap root atau path absolut. Tidak memerlukan user/password. Menunjuk lokasi baru menghasilkan database baru. |
| `DB_HOST` | Default `localhost`; hostname DNS atau alamat IP tanpa protokol/path. Native PostgreSQL menggunakan nilai ini. Docker otomatis memakai `db`. |
| `DB_PORT` | Default `5432`; integer 1–65535 untuk PostgreSQL native. Docker otomatis memakai port internal `5432`. |
| `DB_NAME` | Default `hotel_operations`; 1–63 karakter, diawali huruf/underscore, kemudian huruf/angka/underscore/hyphen. Dipakai juga sebagai `POSTGRES_DB`. |
| `DB_USER` | Wajib untuk postgres; format identifier sama seperti DB_NAME. `.env.example` memakai contoh `hotel_admin`. Dipakai juga sebagai `POSTGRES_USER`. |
| `DB_PASSWORD` | Wajib non-blank untuk postgres; maksimum 1024 karakter, tanpa NUL/baris baru. Tidak ada default password production. Placeholder umum ditolak. Dipakai juga sebagai `POSTGRES_PASSWORD`. Embedded mengabaikannya. |
| `DB_SSL` | `false` (default) atau `true`. True memvalidasi sertifikat TLS PostgreSQL dengan trust store Node. Service internal PostgreSQL bawaan Compose menggunakan false; true memerlukan server TLS yang memang disiapkan. |
| `ENCRYPTION_KEY` | Secret AES-GCM berupa 64 karakter hexadecimal. Wajib production atau untuk konfigurasi OHIP sungguhan. Generate 32 random bytes secara kriptografis; jangan mengganti kunci tanpa rencana migrasi kredensial tersimpan. |
| `COOKIE_SECURE` | `false` atau `true`; true membutuhkan HTTPS APP_URL. Production dengan URL publik wajib HTTPS dan true; production loopback lokal boleh HTTP. |
| `OHIP_ALLOWED_HOSTS` | Kosong menolak semua gateway live; atau hostname gateway HTTPS yang disetujui, dipisahkan koma. Tanpa skema, wildcard, atau alamat IP. Pemeriksaan keamanan OHIP tetap berlaku. |
| `POLL_INTERVAL_MS` | Default `60000`, integer 30000–86400000. Jadwal polling worker. |
| `OHIP_REQUEST_INTERVAL_MS` | Default `250`, integer 250–60000. Jeda minimum request OHIP. |
| `DEMO_SEED` | Default `false`. True hanya di development/test, mewajibkan DEMO_PASSWORD; hanya mengisi database yang belum mempunyai user. |
| `DEMO_PASSWORD` | Secret bootstrap demo 12–256 karakter. Tidak dicetak dan tidak di-default. Mengubahnya tidak mengubah akun yang sudah ada. |

Untuk karakter khusus (`$`, `#`, `:`, `@`, `/`, spasi), gunakan single quotes di `.env`, misalnya `DB_PASSWORD='secret-unik-yang-Anda-buat'`. Jangan memakai placeholder tersebut sebagai secret. Hindari apostrof/baris baru pada nilai yang dikutip dengan single quotes. Aplikasi mengirim konfigurasi koneksi sebagai parameter terpisah ke driver PostgreSQL; tidak membangun `DATABASE_URL`, sehingga password tidak melewati parsing/interpolasi URL. Jangan mengekspor variabel DB/APP_PORT berbeda di shell saat menjalankan Compose: interpolasi Compose harus sama dengan root `.env`. Preflight menolak perbedaan pada DB_NAME, DB_USER, DB_PASSWORD, atau APP_PORT sebelum DB diinisialisasi.

Variabel lama `DATABASE_URL`, `LOCAL_DEMO`, `LOCAL_DB_PATH`, `PORT`, `HOST`, `APP_ORIGIN`, `POSTGRES_PASSWORD` tidak lagi diterima dalam `.env`. Migrasikan ke nama di tabel. `APP_MODE=demo/server` diganti native/docker; pemilihan sample data memakai DEMO_SEED. Untuk database embedded lama, pertahankan path lamanya di DB_FILE (misalnya `./data/demo`) agar data tetap terbaca.

## Native

1. Salin `.env.example` ke `.env` jika belum ada; isi ENCRYPTION_KEY dan pilih APP_MODE=native.
2. Pilih DB_TYPE=embedded (tanpa DB credentials), atau postgres dan isi alamat server/database/user/password yang sudah diprovisikan.
3. Jalankan `npm install`, `npm run build`, `npm start`.

Default production lokal dapat memakai embedded dan HTTP loopback. Untuk akses jaringan, pakai reverse proxy HTTPS dengan forwarding WebSocket dan APP_URL publik yang benar. Listener native berada di loopback. Akun production tidak dibuat otomatis; pertahankan proses provisioning identitas yang sudah ada.

## Docker

1. Hentikan native. Set APP_MODE=docker, DB_TYPE=postgres dan isi DB_NAME/DB_USER/DB_PASSWORD, ENCRYPTION_KEY dalam root `.env`.
2. Jalankan `docker compose up --build -d`.
3. Periksa `docker compose ps` dan `docker compose logs app`.

Service config-check memakai image yang sama dan menolak konfigurasi tidak valid sebelum DB dimulai. Compose memetakan DB_NAME/DB_USER/DB_PASSWORD ke POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD. App membaca file yang sama, otomatis terhubung ke db:5432 dan menunggu `service_healthy`. Healthcheck db menggunakan nama/user yang sama. PostgreSQL tidak mempunyai `ports`; hanya app dipublikasikan pada loopback APP_PORT. Host port publik disediakan reverse proxy bila diperlukan.

`.dockerignore` mengecualikan `.env`, variasi file env lokal, data, artefak, dan Git. Dockerfile tidak mempunyai ARG/ENV secret. File `.env` dipasang read-only saat runtime; volume bind `./data:/app/data` menyediakan deployment lock bersama native/Docker. Pada Linux, pastikan direktori data dapat ditulis oleh user container `node` (UID 1000), tanpa memberi izin baca `.env` kepada pengguna yang tidak perlu.

## Startup, perubahan konfigurasi, dan persistensi

Urutan startup: baca `.env` ? validasi schema/mode/secret ? ambil deployment lock ? periksa koneksi DB (`SELECT 1`, timeout PostgreSQL 5 detik) ? migrasi transaksi idempotent ? optional demo seed ? Fastify listener ? worker. Nama, mode, jenis DB, port, dan `connection=ready` dicetak setelah listen berhasil; kredensial, key, dan password demo tidak dicetak. Error autentikasi, database tidak ada, dan koneksi gagal memberikan petunjuk tanpa menampilkan error driver mentah.

Migrasi menggunakan advisory transaction lock dan tabel schema_migrations; restart tidak menjalankan ulang versi yang sudah diterapkan. Tidak ada perubahan schema bisnis pada perbaikan konfigurasi ini. `npm run db:migrate` menggunakan loader yang sama; seed CLI juga menolak production. Build menghasilkan `dist/server/`, `dist/public/`, dan `dist/migrations/`; hanya dist/public yang disajikan sebagai static files. File `.env` dan kredensial DB tidak diberikan melalui endpoint API.

Untuk mengubah variabel, hentikan deployment aktif, edit root `.env`, lalu jalankan kembali command mode yang dipilih. Untuk Docker gunakan `docker compose up --build -d` agar konfigurasi container diperbarui. Jangan hanya `restart` setelah mengganti env karena env healthcheck container perlu diperbarui juga. Jangan menjalankan kedua mode bersamaan. Lock tunggal berlaku meskipun port/database berbeda. Setelah shutdown paksa, tunggu 30 detik sampai heartbeat lock dianggap kedaluwarsa. Jika proses mati saat recovery lock dan meninggalkan `data/.deployment.lock.recovery`, hentikan semua proses aplikasi sebelum menghapus marker recovery tersebut.

Native embedded menyimpan data di DB_FILE; backup seluruh direktori saat aplikasi berhenti. PostgreSQL eksternal dikelola administrator server. Docker menyimpan PostgreSQL di volume `hospitality-db` yang memiliki prefix project Compose. Restart, down tanpa -v, dan recreate container mempertahankan volume. Jangan menghapus volume untuk mengganti password: POSTGRES_* hanya menginisialisasi volume kosong. Ubah password role melalui administrasi PostgreSQL yang sah, lalu samakan DB_PASSWORD dalam `.env`. Perubahan DB_NAME/DB_USER pada volume lama juga memerlukan provisioning DB/role yang sesuai. Gunakan pg_dump dan uji restore untuk backup PostgreSQL. Mengganti mode tidak melakukan transfer data otomatis.

SPA HTML/assets, REST, OpenAPI dan `/api/ws` berbagi satu listener Fastify. Browser menentukan alamat WebSocket dari location. Refresh nested route mengembalikan SPA; API/assets yang tidak ditemukan tidak berubah menjadi HTML. RBAC, tenant/property scoping, branding, realtime, dan worker tetap memakai implementasi yang ada.

## Pengujian lokal

Jalankan `npm run lint`, `npm run build`, `npm test`, `npm run test:browser`, dan `npm run test:deployment`. PowerShell dapat memakai npm.cmd. Browser memerlukan Chrome/Edge atau Chromium Playwright. Matriks deployment memerlukan Docker lokal, aplikasi berhenti, dan port APP_PORT tersedia. Script sementara mengganti root `.env` dan memulihkannya melalui finally; jangan menyunting `.env` atau menyalakan deployment lain selama test.

Pengujian deployment memakai nama project/container unik, PostgreSQL native uji yang hanya dipublikasikan pada loopback, dan volume Compose uji. Service PostgreSQL aplikasi tetap tanpa published port. Resource Docker khusus test dihapus setelah verifikasi restart/persistensi; volume aplikasi pengguna tidak dihapus. Laporan tersimpan di `artifacts/config-deployment-result.json` serta `artifacts/browser-*-result.json`. Test tidak memvalidasi koneksi OPERA live atau kesiapan production, dan tidak melakukan push/deploy production.
