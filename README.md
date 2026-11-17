# Hospitality Operations Web V1

Konfigurasi runtime berada di **satu file `.env` pada root project**. Kredensial tidak perlu diubah di source code atau Compose. Fastify menyajikan React SPA, REST API, OpenAPI, dan WebSocket terautentikasi melalui satu port, default **http://localhost:3000**.

## Strict OHIP read-only V1

Aplikasi ini adalah **OHIP READ-ONLY OPERATIONAL DASHBOARD**, bukan PMS write client. Indikator **OHIP READ ONLY** selalu ditampilkan. Form/action operasional untuk membuat task, mengubah housekeeping, check-in/out, cancel, posting atau menulis data Oracle tidak tersedia. Connection Manager dan administrasi lokal tetap diizinkan.

```dotenv
OHIP_ACCESS_MODE=read_only
OHIP_MUTATIONS_ENABLED=false
```

Keduanya default ke nilai aman jika tidak ditentukan; nilai lain ditolak saat startup. Policy HTTP pusat tetap default-deny meskipun parameter pengguna atau environment diubah. Hanya OAuth Client Credentials, POST `searchHotelReservations` yang dibatasi, dan varian GET `getReservation` yang telah diaudit boleh melewati policy. GET reservation wajib menonaktifkan `markAsRecentlyAccessed` dan `includeInSession`; GET lain tidak otomatis aman. V1 tetap menampilkan reservation details dari cache lokal, tanpa menambahkan endpoint live baru.

Semua mutasi Oracle, GraphQL dan arbitrary proxy ditolak dengan **403 `OHIP_READ_ONLY_POLICY`** sebelum transport dipanggil. Polling mempertahankan rate limit, scoped deduplication/cache, retry baca aman dan WebSocket. Timestamp event WebSocket bukan timestamp sinkronisasi Oracle; dashboard menampilkan waktu sync per properti dan status snapshot `demo`, `not_synced`, `synced`, atau `stale`.

[Daftar endpoint, batas semantics, pengecualian OAuth, dan bukti pengujian](docs/OHIP_READ_ONLY_POLICY.md). Tidak ada perubahan credentials tersimpan atau schema database untuk penguncian read-only ini.

## Local CRUD dan connection lifecycle

Tabel Oracle memakai klik baris, Enter/Space dan dialog read-only; detail tidak memiliki action mutasi. Tenant/organization/property memiliki create, edit, archive; user memiliki create, edit access, archive membership. Branding dapat disimpan atau di-reset. Semua perubahan lokal diaudit, dibatasi RBAC/tenant, dan tidak mengirim write ke Oracle. Archive mempertahankan histori dan menolak dependency aktif.

Connection Manager menyediakan View, Edit, Test, Stop/Resume per property atau seluruh shared connection, dan Archive. Stop global memerlukan konfirmasi jumlah/nama properti. Pause persisten, memblokir scheduler/enqueue/retry serta outbound policy; credentials/mapping dipertahankan. Resume memvalidasi konfigurasi dan menjadwalkan bounded reconciliation. Status Browser WebSocket, OHIP Connection dan Property Data terpisah; cache paused ditandai Stale.

Migration **0003** menambah pause/archive/revision dan registry soft archive lokal tanpa mengubah nilai credentials. [Semantics, endpoint, proteksi dependency dan validasi](docs/LOCAL_ACTIONS_CONNECTION_CONTROL.md).

## Setup

Gunakan Node.js 24/npm untuk native, atau Docker Engine dengan Compose untuk Docker.

```sh
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

PowerShell: gunakan `Copy-Item .env.example .env`. Isi `ENCRYPTION_KEY` dengan hasil generator. `.env` di-ignore Git dan dikecualikan dari Docker build. Jangan menyalin ulang `.env.example` di atas konfigurasi yang sudah digunakan: kunci enkripsi lama diperlukan untuk membaca kredensial OHIP yang telah disimpan.

## Native

Pilih di `.env` **sebelum menjalankan command**:

```dotenv
APP_MODE=native
DB_TYPE=embedded
```

```sh
npm install
npm run build
npm start
```

Embedded menggunakan PGlite, sebuah PostgreSQL embedded yang persisten. `DB_FILE=./data/app.db` adalah **direktori data**, bukan file SQLite. Untuk PostgreSQL eksternal, ubah `DB_TYPE=postgres` dan isi `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, serta `DB_SSL` di `.env`.

`npm.cmd start` memvalidasi config, manifest/aset frontend, koneksi DB, checksum/history migration dan schema sebelum membuka HTTP/WebSocket. `DB_MIGRATION_MODE=auto` menerapkan pending migration yang diizinkan, memakai lock dan transaksi; versi yang sudah diterapkan dilewati. Backup PGlite melalui API database dibuat sebelum pending migration. Production embedded menolak path yang hilang/kosong agar tidak membuat pengganti database tanpa sengaja. Provision database baru secara eksplisit dalam development terlebih dahulu; jangan mengganti path/key database yang sudah digunakan.

Untuk LAN development HTTP, gunakan `APP_HOST=192.168.1.122`, `APP_PORT=3501`, `APP_URL=http://192.168.1.122:3501`, `NODE_ENV=development`, `COOKIE_SECURE=false`. `APP_HOST` adalah interface listener, `APP_URL` adalah origin browser; `APP_HOST=0.0.0.0` opsional untuk semua interface IPv4. Bind spesifik tidak menjamin localhost ikut mendengarkan. Production jaringan tetap wajib HTTPS dan secure cookies. Frontend memakai API/WebSocket same-origin; startup yang gagal menampilkan pesan, bukan halaman kosong.

Banner READY dicetak setelah listen berhasil, dengan mode Native/Docker, engine DB, migration, bind/URL, readiness serta status OHIP tersimpan (bukan klaim live sehat). `STARTUP_DASHBOARD=auto`, `TRAFFIC_METER_ENABLED=true`, `TRAFFIC_METER_INTERVAL_MS=1000` menampilkan **APPLICATION SERVER TRAFFIC** di terminal interaktif: throughput socket HTTP/WebSocket, HTTP rate/status/latency, WS clients/messages dan counter OHIP terpisah. Redirect/service/Docker menggunakan log JSON tanpa animasi. Ctrl+C menghentikan meter dan menutup server. [Workflow, backup, batas keamanan dan bukti validasi](docs/STARTUP.md).

## Docker

Pilih di `.env`:

```dotenv
APP_MODE=docker
DB_TYPE=postgres
DB_NAME=hotel_operations
DB_USER=hotel_admin
# Isi DB_PASSWORD dengan secret unik sebelum menjalankan Compose.
```

```sh
docker compose up --build -d
docker compose ps
docker compose logs app
```

Compose membaca root `.env`, melakukan validasi sebelum PostgreSQL berjalan, menunggu DB sehat, lalu menjalankan Fastify. DB selalu menggunakan `db:5432` di Docker; tidak ada port PostgreSQL yang dipublikasikan. Data PostgreSQL berada di named volume. `.env` dipasang read-only saat runtime, dan tidak dimasukkan ke image/frontend.

Hentikan deployment aktif sebelum mengganti `APP_MODE`: Ctrl+C untuk native, atau `docker compose down` untuk Docker. Jangan gunakan `down -v` pada database yang ingin disimpan. Startup menolak command yang tidak sesuai mode dan menggunakan lock bersama di `data/` untuk mencegah dua deployment aktif, termasuk jika portnya berbeda. Setelah proses dihentikan paksa, tunggu 30 detik untuk pemulihan lock.

## Data dan fitur

Default `NODE_ENV=production` tidak mengisi akun atau data demo. Provisioning identitas production mengikuti proses administrasi yang sudah ada. Untuk mencoba fitur dengan data sintetis, set `NODE_ENV=development`, `DEMO_SEED=true`, dan `DEMO_PASSWORD` yang unik (minimal 12 karakter) di `.env`. Database tanpa user akan diisi sekali; login `admin@demo.local` memakai password tersebut. Password tidak dicetak di log. Database yang sudah berisi user tidak di-reset.

RBAC, multi-tenant/property authorization, white-label branding, seluruh menu operasional, worker OHIP, dan realtime tetap dipertahankan. [Panduan variabel, keamanan, backup, dan deployment](docs/DEPLOYMENT.md) menjelaskan seluruh pengaturan. Native dan Docker memiliki penyimpanan berbeda; mengganti mode tidak memindahkan data otomatis.

## OHIP Connection Center (OCIM)

Buka **Integrations > OHIP Connections**, pilih properti di workspace, lalu **Create New Connection**. Form hanya berisi enam parameter: `baseUrl`, `clientId`, `clientSecret`, `appKey`, `enterpriseId`, dan `hotelId`. Tidak ada Chain Mapping, Chain ID, environment, atau scope tambahan sebagai input wajib.

Untuk credentials yang sama, pilih **Use Existing Connection**, pilih connection, lalu masukkan **Hotel ID properti tersebut**. Untuk credentials berbeda, pilih **Create Dedicated Connection** atau **Create New Connection**. Backend memvalidasi OAuth dan akses reservation API untuk Hotel ID sebelum aktivasi. Properti yang berisi reservasi demo harus dipisahkan dari properti Oracle agar sumber data tidak tercampur.

**Edit Connection** mempertahankan client secret dan application key jika kolomnya dikosongkan. Perubahan credentials bersama diuji terhadap seluruh Hotel ID terkait dan membutuhkan grant ke semua properti tersebut. Credentials identik disimpan sekali dalam tenant; credentials tidak dibagikan lintas tenant. Connection List menampilkan Assigned Properties, Test Connection, Last Connected dan Connection Health. Secret yang tersimpan tidak dikirim ke browser.

Backend memakai OCIM Client Credentials ke `baseUrl/oauth/v1/tokens`, scope tetap `urn:opc:hgbu:ws:__myscopes__`, cache token per tenant/connection/revisi credentials, pembaruan sebelum kedaluwarsa, dan satu refresh setelah HTTP 401. Oracle tidak menggunakan refresh-token grant pada alur ini. Header operasional memakai Bearer token, `x-app-key`, dan `x-hotelid` dari assignment properti. [Spesifikasi header dan scope Oracle](https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/c_calling_oracle_hospitality_property_apis_ocim.htm).

Migrasi `0002_ocim_connections.sql` dan backfill transaksional memisahkan credentials ke `ohip_connections` dan Hotel ID ke `ohip_connection_properties`. Backup database dan simpan ENCRYPTION_KEY asli sebelum upgrade. Migrasi mempertahankan credentials serta assignment lama, menyatukan credentials identik hanya dalam tenant, dan mempertahankan kolom chain historis. Key yang salah membatalkan seluruh migrasi. Assignment lama tanpa bukti koneksi sukses berstatus pending sampai **Test Connection** berhasil. [Detail migrasi dan API](docs/OHIP_OCIM.md).

## Housekeeping Worksheet

Buka `/operations/rooms`: satu worksheet untuk memuat kamar OPERA, drag/drop kamar dan attendant, lalu **Print Worksheet**. Property/business date memakai selector existing; shift, Last OHIP sync, filter floor/status/room type, batch assignment dan Undo tersedia pada layar yang sama. Assignment autosave lokal dengan debounce, optimistic update, rollback, transaksi, revision check dan audit. Coverage supervisor serta jadwal staff diselesaikan otomatis saat assignment; tidak ada Save per kamar atau form setup harian.

Kamar live berasal dari GET `getHousekeepingOverview`; task/credits dilengkapi dari GET existing task sheets `getHouseKeepingTasks` dengan **generateCleaningSequence=false**. OAuth dan polling reservation read-only existing dipertahankan. Tidak ada mutasi status kamar, task sheet, atau assignment Oracle. Jika feed tidak tersedia/authorized, tampilkan empty/error state; tidak ada fallback DEMO atau kamar Unknown buatan. Floor berasal dari OHIP atau override directory tervalidasi. Credits ditandai OHIP, Local rule, atau belum dikonfigurasi.

Registered users, membership tenant/property, Housekeeping role metadata, RBAC, dan assignment existing tetap dipakai. Attendant login langsung ke **My Worksheet**; supervisor ke **My Team**. Update masuk lewat Fastify WebSocket. Konfigurasi administratif existing dipisahkan ke `/operations/rooms-settings`. Migration 0005 menambah cache feed dan audit/undo worksheet tanpa mengganti migration/data sebelumnya.

Print preview menggunakan HTML/CSS A4 portrait, page break per attendant, total attendant/supervisor, status, task, credits dan remarks. Tombol Print/Save PDF memakai browser, tanpa layanan eksternal. [Kontrak, audit UX dan batas operasional](docs/HOUSEKEEPING.md).

Smoke terisolasi: `npm.cmd run build` lalu `npm.cmd run test:housekeeping-smoke`. Test memakai database disposable dan port acak, tidak mengubah `.env` atau runtime/database pemilik. Live OHIP perlu acceptance terhadap entitlement dan response properti nyata; hasil lokal bukan bukti production.

## Verifikasi

```sh
npm run lint
npm run build
npm test
npm run test:browser
npm run test:deployment
```

PowerShell dapat memakai `npm.cmd`. Browser test memerlukan Chrome/Edge atau Chromium Playwright. `test:deployment` memerlukan Docker lokal dan Chromium; jalankan saat aplikasi berhenti. Script menguji tiga kombinasi mode/DB, error startup, restart, persistensi, serta SPA/API/WebSocket satu port menggunakan database terisolasi. Script mengganti `.env` sementara dan memulihkannya di akhir; jangan menjalankan proses deployment lain bersamaan. Hasil ada di `artifacts/`. Pengujian ini tidak melakukan push atau deployment production.

[Feature coverage](docs/OPERATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md)
