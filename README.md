# Hospitality Operations Web V1

Konfigurasi runtime berada di **satu file `.env` pada root project**. Kredensial tidak perlu diubah di source code atau Compose. Fastify menyajikan React SPA, REST API, OpenAPI, dan WebSocket terautentikasi melalui satu port, default **http://localhost:3000**.

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
