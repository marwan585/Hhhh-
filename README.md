# ☁ CLOUD WA TOOLS

**Real WhatsApp Management & Messaging Tool untuk Terminal / Termux / Linux / VPS.**

Aplikasi CLI (command line interface) dengan menu interaktif yang terhubung langsung ke
jaringan WhatsApp melalui protokol WhatsApp Web Multi-Device (library
[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)). Bukan website,
bukan simulasi: pairing code dihasilkan oleh server WhatsApp, pesan benar-benar
terkirim, dan seluruh data tersimpan di database SQLite lokal.

> ⚠️ **Dokumentasikan batasan**: integrasi ini menggunakan protokol tidak resmi
> (berbasis perangkat, seperti WhatsApp Web). Autentikasi dan session sepenuhnya
> menggunakan mekanisme asli dari library. Lihat bagian [Batasan & Risiko](#-batasan--risiko).
> Untuk deployment skala besar, WhatsApp Business Platform (Cloud API resmi Meta)
> tetap pilihan yang lebih aman.

---

## ✨ Fitur

| Modul | Kemampuan |
|---|---|
| Koneksi WhatsApp | Pairing code asli `XXXX-XXXX` (Link with phone number), restore session otomatis, auto-reconnect, deteksi session expired |
| Cloud Save | Quick send, simpan history (Phone, Name, Campaign, Message ID, Sent At, Delivery Status), arsip percakapan |
| Cloud Master | Semua fitur Cloud Save + arsip pesan lokal, arsip media, campaign history, recipient history, storage management, backup |
| Campaign | Buat/start/pause/resume/stop, recipient dari `.txt` `.csv` `.xlsx`, template `{{name}}`/`{{phone}}`, progress bar realtime |
| Queue | Pengiriman satu per satu dengan delay acak (min–max), pause/resume/stop aman, tahan crash (persistent SQLite) |
| Rate Limit | Minimum/maximum delay, messages per session, cooldown per nomor, maximum retry — **tanpa** bypass anti-spam |
| Consent | Opt-in/opt-out database, keyword `STOP` / `UNSUBSCRIBE` / `BERHENTI` otomatis masuk Do Not Contact |
| Duplicate Protection | Cek nomor → opt-in → blacklist → campaign sebelumnya → cooldown → antrian |
| Incoming Handler | Menampilkan pesan masuk, opt-out otomatis, arsip media masuk |
| Storage | Lihat pemakaian, hapus pesan/media lama (7/30/90/custom hari), export CSV/JSON |
| Backup | Database + konfigurasi; session **tidak** ikut kecuali backup terenkripsi eksplisit (AES-256-GCM) |
| Logging | File harian `logs/app-YYYY-MM-DD.log`, filter hari ini / error |
| Crash Recovery | Campaign `RUNNING` saat aplikasi mati akan ditawarkan Resume/Stop/View saat boot berikutnya |
| CLI Command | `cloud-wa status`, `cloud-wa campaign start <id>`, dan lainnya |

---

## 📋 Persyaratan

- **Node.js 20 atau lebih baru** (wajib — engine koneksi WhatsApp berbasis Node.js)
- npm (bundel dengan Node.js)
- Koneksi internet aktif
- Tidak butuh kompilasi native — driver SQLite memakai WebAssembly (`sql.js`),
  sehingga aman dipakai di Termux/Android tanpa `pkg install clang` dsb.

Cek kesiapan lingkungan kapan pun:

```bash
cloud-wa check
```

---

## 📦 Instalasi

### Termux (Android)

```bash
pkg update && pkg upgrade
pkg install nodejs git
git clone <url-repo-anda>/cloud-wa-tools.git   # atau ekstrak arsip release
cd cloud-wa-tools
bash install.sh
```

Installer otomatis: mendeteksi Termux, memasang dependensi, membuat direktori
`data/ logs/ config/`, membuat `config/config.json`, menginisialisasi database,
membuat perintah `cloud-wa` di `$PREFIX/bin` (launcher script), lalu menjalankan
tes aplikasi.

> ⚠️ **PENTING untuk Termux — lokasi instalasi**
>
> **Jangan** menaruh proyek ini di penyimpanan bersama Android
> (`/storage/emulated/0/Download/...` atau `/sdcard/...`). Filesystem tersebut
> **tidak mendukung symlink**, sehingga `npm install` selalu gagal dengan
> error `EACCES: permission denied, symlink ... node_modules/.bin/...`.
>
> Letakkan proyek di penyimpanan internal Termux (`$HOME`), contoh:
>
> ```bash
> cd ~                              # <- home Termux, bukan /storage
> unzip /storage/emulated/0/Download/cloud-wa-tools.zip
> cd cloud-wa-tools
> bash install.sh
> ```
>
> Installer terbaru **mendeteksi otomatis** bila Anda menjalankannya dari
> `/storage/emulated/0` dan menawarkan memindahkan proyek ke
> `$HOME/cloud-wa-tools` (jawab `Y`). Bila tetap ingin memasang di tempat,
> installer otomatis memakai mode `--no-bin-links`.

### Linux / Ubuntu / Debian VPS

```bash
sudo apt update && sudo apt install -y nodejs npm   # atau NodeSource untuk Node 20+
cd cloud-wa-tools
bash install.sh
```

### Instalasi satu baris (hosting sendiri)

Host file `install.sh` di GitHub/website Anda, lalu:

```bash
curl -fsSL https://domain-anda.example/install.sh -o install.sh && bash install.sh
```

> Ganti domain dengan URL hosting Anda sendiri. Installer tidak pernah meminta
> data pribadi dan tidak menyimpan apa pun di luar folder proyek.

### npm (semua platform, termasuk Windows)

```bash
npm install
npm start          # menjalankan menu interaktif
# atau global:
npm install -g .   # menyediakan perintah `cloud-wa`
```

### Windows

Gunakan **Windows Terminal / PowerShell** dengan Node.js 20+ terpasang:

```powershell
npm install
npm start
```

Warna dan box-drawing tampil otomatis; terminal lama tanpa dukungan ANSI akan
menampilkan plain text.

---

## 📱 Koneksi & Pairing WhatsApp

Saat pertama kali dijalankan:

```
╔════════════════════════════════════╗
║           CLOUD WA TOOLS           ║
╚════════════════════════════════════╝

WhatsApp Status: DISCONNECTED
 [1] Connect WhatsApp
 [2] Exit
```

1. Pilih `[1]`, masukkan nomor WhatsApp Anda:

   ```
   Enter WhatsApp number: +628xxxxxxxxxx
   Generating pairing code...
   Pairing Code: XXXX-XXXX
   Open WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number
   Waiting for connection...
   ```

2. Buka WhatsApp di HP → **Settings → Linked Devices → Link a Device →
   Link with phone number** → masukkan kode tersebut.
3. Setelah berhasil:

   ```
   ✓ WhatsApp Connected
   Number : +628xxxxxxxxxx
   Status : CONNECTED
   ```

> Kode pairing **selalu berasal dari server WhatsApp** (via
> `requestPairingCode()` milik Baileys). Aplikasi ini tidak pernah membuat
> kode palsu.

### Session Persistence

Setelah pairing sukses, kredensial disimpan oleh library (folder `data/sessions/`).
Tutup terminal, jalankan `cloud-wa` lagi:

```
✓ Existing WhatsApp session found
✓ Restoring session...
✓ WhatsApp Connected
```

Anda **tidak perlu pairing ulang** setiap restart. Menu `[9] WhatsApp Connection`
menyediakan:

```
 [1] Connect WhatsApp (pairing code)
 [2] Reconnect
 [3] Disconnect
 [4] Delete Session
```

> ⚠️ Folder `data/sessions/` berisi kredensial setara akses penuh akun Anda dari
> perangkat ini. Jangan pernah dibagikan, dan sudah masuk `.gitignore`.

---

## ☁ Cloud Save vs Cloud Master

**Cloud Save** (menu `[1]`) — mode pengelolaan kontak & history:

- Quick Send satu nomor (verifikasi nomor terdaftar, peringatan consent)
- Saved Messages: riwayat pengiriman (Phone, Name, Campaign, Message ID, Sent At, Delivery Status)
- Contacts, Campaign, Export history
- Arsip percakapan setelah kirim (jika `archive_after_send` aktif)

```
✓ Message sent
✓ Contact saved
✓ Conversation archived
```

**Cloud Master** (menu `[2]`) — semua fitur Cloud Save ditambah:

- **Message Archive** — semua pesan masuk/keluar tersimpan di SQLite
- **Media Archive** — media masuk disimpan ke `data/media/`
- **Campaign History** — statistik per campaign + breakdown penerima
- **Recipient History** — timeline pesan per nomor + status consent
- **Storage Management** — lihat/hapus/export/backup/restore

Setiap pesan terkirim tercatat:

```
Message ID : 3EB0B1234567...
Recipient  : +628xxxxxxxxxx
Campaign   : Promo September
Message    : Halo Andi...
Time       : 20:31:22
Status     : SENT
```

Status DELIVERED/READ diperbarui otomatis dari receipt asli WhatsApp selama
aplikasi terhubung.

---

## 📣 Campaign

Menu `[3] Campaign`:

```
 [1] Create Campaign
 [2] Start Campaign
 [3] Pause Campaign
 [4] Resume Campaign
 [5] Stop Campaign
 [6] Campaign History
```

### Membuat campaign

```
Campaign Name: Promo September
Message: Halo {{name}}, Kami memiliki informasi terbaru untuk Anda. Terima kasih.
Recipient File: recipients.csv
Delay (min-max detik) [6-15]: 6-15
Maximum Recipients (0 = unlimited): 100
```

### Format file recipient

**TXT** — satu nomor per baris (boleh `Nama,nomor`, komentar `#` diabaikan):

```
628123456789
628987654321
628111111111
```

**CSV** — dengan header `name,phone` (atau `phone,name`, `nomor,nama`, dst.):

```csv
name,phone
Andi,628123456789
Budi,628987654321
```

**XLSX** — worksheet pertama, deteksi header sama seperti CSV.

Nomor lokal `08xx` otomatis dikonversi ke `628xx`. Duplikat dalam file dihilangkan.
Contoh tersedia di folder `examples/`.

### Queue & progress

Pesan dikirim **satu per satu** dengan jeda acak antara delay min–max:

```
Campaign : Promo September  ████████████░░░░░░░░ 60%  │  Sent : 60  Pending : 35  Failed : 5  │  +628123… ✓ sent
```

- `[3] Pause` / `[4] Resume` / `[5] Stop` bereaksi < 1 detik
- `Ctrl+C` saat campaign berjalan = **pause aman** (progress tersimpan, tekan
  sekali lagi untuk keluar)
- Jika Termux/VPS mati mendadak: saat aplikasi dijalankan lagi muncul

  ```
  Previous campaign detected.
  Campaign: Promo September
  Last status: RUNNING
   [1] Resume
   [2] Stop
   [3] View Progress
  ```

  Antrian tersimpan di SQLite — tidak ada data yang hilang.

### Safe Rate Limit (konfigurasi)

| Setting | Default | Arti |
|---|---|---|
| `min_delay` | 6 | Jeda minimum antar pesan (detik) |
| `max_delay` | 15 | Jeda maksimum (detik) |
| `messages_per_session` | 50 | Batas kirim per sesi, lalu auto-pause |
| `cooldown_hours` | 24 | Nomor yang baru dikirim di-skip bila dikirim lagi dalam jendela ini |
| `max_retry` | 3 | Percobaan ulang per pesan untuk kegagalan teknis (bukan restriction) |

Jika WhatsApp menolak/membatasi (error 401/403/429, indikasi banned/spam):

```
⚠ WhatsApp restriction detected
Campaign automatically paused. Please review recipient consent and messaging activity.
```

Campaign otomatis berhenti — **tidak** ada mekanisme bypass anti-spam, bypass
rate limit, fake typing, fake device, fake delivery status, atau penghindaran
sistem keamanan WhatsApp di aplikasi ini.

---

## 👥 Contacts, Opt-in & Opt-out

Menu `[4] Contacts`:

```
 [1] Add Contact        [5] Opt-in
 [2] Import Contacts    [6] Opt-out
 [3] View Contacts      [7] Do Not Contact list
 [4] Delete Contact
```

Struktur tabel `contacts` (SQLite):

```sql
id, phone, name, opt_in, opt_in_at, opt_out, opt_out_at, created_at, updated_at
```

- Hanya nomor **opt-in** yang boleh masuk campaign
- Nomor opt-out / blacklist **tidak akan pernah** masuk antrian
- Saat import, aplikasi menanyakan apakah kontak ditandai opt-in — jawab
  **n** kecuali Anda yakin mereka memberi izin

### Keyword berhenti berlangganan

Jika pesan masuk berisi `STOP`, `UNSUBSCRIBE`, atau `BERHENTI`:

```
Incoming Message
From: +628xxxxxxxxxx
Message: STOP

✓ Recipient added to Do Not Contact
```

Nomor langsung opt-out + masuk daftar Do Not Contact. Pesan masuk disimpan ke
history bila `save_incoming_messages` aktif di Settings.

### Duplicate protection

Setiap recipient melewati pipeline sebelum masuk antrian (dan dicek ulang
tepat sebelum dikirim):

```
Check number → Check opt-in → Check blacklist → Check previous campaign → Check cooldown → Queue
```

Contoh output ketika ter-skip:

```
Skipped: +628xxxxxxxxxx Reason: Recently contacted
```

---

## 💾 Storage Management

Menu `[6] Storage` / Cloud Master:

```
CLOUD MASTER STORAGE
 Messages : 14,820
 Media    : 182 MB (1,204 files)
 Database : 34 MB
 Logs     : 8 MB
 Backups  : 12 MB
 Total    : 236 MB
```

```
 [1] View Storage        [4] Export History
 [2] Delete Old Messages [5] Backup Database
 [3] Delete Media        [6] Restore Database
```

Cleanup berdasarkan umur data: **7 / 30 / 90 hari / custom**.
Export mendukung CSV dan JSON ke `data/exports/`.

---

## 🗄 Backup & Restore

```bash
cloud-wa backup                                # database + konfigurasi
cloud-wa backup --include-session --password "rahasia-anda"   # + session TERENKRIPSI
cloud-wa restore backup-20260930120000
```

Isi backup: database (campaign, contacts, message history, queue), konfigurasi,
manifest. **Kredensial session tidak pernah ikut** kecuali Anda secara eksplisit
mengaktifkan encrypted session backup (AES-256-GCM, key derivation scrypt —
implementasi `node:crypto` bawaan Node.js).

---

## 🖥 Command Mode

Selain menu interaktif:

```bash
cloud-wa                                 # menu interaktif
cloud-wa status                          # status session, campaign, queue
cloud-wa connect [--number +62xxx]       # pairing & tetap terhubung
cloud-wa disconnect                      # detach (session tetap tersimpan)
cloud-wa session delete                  # hapus session tersimpan
cloud-wa campaign list
cloud-wa campaign create --name "Promo" --message "Halo {{name}}" --file contacts.csv --delay 6-15
cloud-wa campaign start <id>             # kirim sampai selesai; Ctrl+C = pause
cloud-wa campaign pause <id>
cloud-wa campaign resume <id>
cloud-wa campaign stop <id>
cloud-wa contacts list [--filter opted_in] [--search teks]
cloud-wa contacts import contacts.csv [--opt-in]
cloud-wa contacts add 628123456789 "Andi"
cloud-wa contacts optin 628123456789
cloud-wa contacts optout 628123456789
cloud-wa history [--limit 20] [--campaign 1] [--phone 628123456789]
cloud-wa storage
cloud-wa logs [--today] [--errors] [--tail 50]
cloud-wa backup [--include-session --password XXX]
cloud-wa restore <backup-name>
cloud-wa check                           # dependency check
cloud-wa init                            # buat direktori + config + database
```

`python main.py` juga tersedia sebagai shim kompatibilitas yang meneruskan
argumen ke Node.js (stack aplikasi ini adalah Node.js — lihat penjelasan di
file tersebut).

---

## ⚙️ Konfigurasi

`config/config.json` (dibuat otomatis dari `config/config.example.json`):

```json
{
  "database_path": "./data/database.sqlite",
  "session_path": "./data/sessions",
  "log_path": "./logs",
  "message_storage": "./data/messages",
  "media_storage": "./data/media",
  "backup_path": "./data/backups",
  "export_path": "./data/exports",
  "default_country_code": "62",
  "name_fallback": "",
  "min_delay": 6,
  "max_delay": 15,
  "messages_per_session": 50,
  "cooldown_hours": 24,
  "max_retry": 3,
  "archive_after_send": true,
  "verify_recipients": true,
  "save_incoming_messages": true,
  "media_archive": true,
  "log_retention_days": 30
}
```

Atau via `.env` (salin `.env.example` → `.env`) — nilai `.env` menimpa
`config.json`:

```env
DATABASE_PATH=./data/database.sqlite
SESSION_PATH=./data/sessions
LOG_PATH=./logs
MESSAGE_STORAGE=./data/messages
MEDIA_STORAGE=./data/media
CLOUD_WA_MIN_DELAY=6
CLOUD_WA_MAX_DELAY=15
```

> 🔐 `.env`, `config/config.json`, `data/` (termasuk `data/sessions/`), dan
> `logs/` semuanya sudah masuk `.gitignore`. Jangan pernah menyimpan secret di
> dalam Git.

---

## 📁 Struktur Proyek

```
cloud-wa-tools/
├── bin/cloud-wa.js            # entry point executable
├── src/
│   ├── cli/                   # main, menus, command mode, terminal UI
│   ├── whatsapp/              # koneksi Baileys, pairing, incoming handler
│   ├── campaign/              # manager, runner (queue consumer), template, parser recipient
│   ├── contacts/              # kontak + consent + blacklist
│   ├── storage/               # storage manager, backup/restore
│   ├── database/              # wrapper SQLite (sql.js) + schema
│   ├── queue/                 # antrian persisten + duplicate protection
│   ├── logger/                # logger file harian
│   └── utils/                 # config, paths, phone, datetime, deps check
├── data/                      # database.sqlite, sessions/, messages/, media/, backups/
├── logs/                      # app-YYYY-MM-DD.log
├── config/                    # config.json (+ contoh)
├── tests/                     # automated tests
├── examples/                  # contoh file recipient
├── install.sh
├── main.py                    # shim kompatibilitas
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

---

## 🧪 Testing

```bash
npm test
```

Mencakup: database, contacts, duplicate detection, opt-in/opt-out, queue,
campaign pause/resume/stop, restriction auto-pause, storage, backup (+ enkripsi
session), konfigurasi, logger, error handling. Unit test menggunakan **stub
WhatsApp yang ditandai jelas sebagai test** — keberhasilan pengiriman tidak
pernah dipalsukan.

**Integration test WhatsApp (LIVE)** dibatalkan secara default dan **tidak
pernah memalsukan sukses** — jalankan hanya bila Anda siap mem-pairing sungguhan:

```bash
WA_LIVE_TEST=1 WA_TEST_NUMBER=+628xxxx WA_TEST_TO=+628yyyy \
  node --test tests/whatsapp.integration.test.js
```

---

## 🔧 Troubleshooting

| Masalah | Penyebab & solusi |
|---|---|
| `Node.js not found` | Install Node.js 20+ (`pkg install nodejs` / NodeSource). Lalu `cloud-wa check` |
| Pairing code gagal diminta (`Connection Closed` / 401) | Sudah ditangani otomatis: aplikasi menunggu handshake selesai (event QR) sebelum meminta pairing code, mencoba ulang, dan bila perlu memulai ulang pairing dengan sesi bersih (maks. 2x). Pastikan internet stabil dan nomor aktif di WhatsApp |
| `SESSION_EXPIRED` / keluar dari HP | Menu `[9]` → `Delete Session` → `Connect` lalu pairing ulang |
| `Connection replaced` | Session dibuka di perangkat lain; tutup yang lain lalu Reconnect |
| Koneksi terputus berkali-kali di Termux | Matikan optimasi baterai untuk Termux; hindari mode hemat daya agresif; aplikasi auto-reconnect hingga 8x |
| Pesan gagal `Number is not registered` | Nomor tujuan tidak aktif di WhatsApp — dicek otomatis bila `verify_recipients` aktif |
| Campaign berhenti sendiri | Baca `status_note` di Campaign History — biasanya restriction WhatsApp atau batas `messages_per_session` |
| SQLite error di Termux | Tidak perlu — driver WASM. Pastikan ruang penyimpanan cukup. Sesi WhatsApp aktif jangan ditaruh di `/storage/emulated/0` (lambat & tidak mendukung symlink) |
| `npm install` lambat/gagal di Termux | Pastikan `pkg install nodejs` terbaru; coba ulang; gunakan WiFi |
| `npm error EACCES ... symlink ... node_modules/.bin/...` | Anda menginstall di penyimpanan bersama Android (`/storage/emulated/0`, `/sdcard`) yang **tidak mendukung symlink**. Solusi: pindahkan proyek ke home Termux (`cd ~ && mv /storage/emulated/0/Download/cloud-wa-tools ~ && cd ~/cloud-wa-tools && bash install.sh`) — atau jawab `Y` saat installer baru menawarkan pemindahan otomatis — atau tambahkan `printf 'bin-links=false\n' >> .npmrc` lalu jalankan ulang `bash install.sh` |
| Warna tidak muncul | Terminal tidak mendukung ANSI — aplikasi otomatis plain text |

Log lengkap: `cloud-wa logs --today`, error saja: `cloud-wa logs --errors`.

---

## 🔐 Security & Privacy

- **Session = akses penuh akun Anda** dari perangkat ini. Simpan baik-baik,
  jangan pernah dikomit/dibagikan; `data/sessions/` ada di `.gitignore`.
- Backup tidak menyertakan session kecuali Anda eksplisit memilih encrypted
  session backup berpassword.
- Tidak ada telemetri, tidak ada data yang dikirim ke server pihak ketiga
  selain ke jaringan WhatsApp itu sendiri.
- Data recipient & history sepenuhnya lokal di SQLite Anda.
- **Gunakan hanya untuk pesan yang diizinkan penerimanya.** Spam melanggar
  hukum (mis. UU PDP di Indonesia) dan ketentuan layanan WhatsApp.

---

## ⚠️ Batasan & Risiko

- Aplikasi memakai **library tidak resmi** berbasis protokol WhatsApp Web
  Multi-Device. Autentikasi, pairing code, dan session 100% mekanisme asli
  library — tetapi Meta dapat mengubah protokol kapan saja sehingga library
  perlu diperbarui.
- Akun yang mengirim pesan massal tanpa persetujuan penerima berisiko
  **dibatasi atau dibanned oleh WhatsApp**. Rate limit di aplikasi ini
  dirancang untuk mengurangi risiko teknis, **bukan** untuk menjamin akun
  aman, dan **tidak** menyediakan cara menghindari sistem keamanan WhatsApp.
- Receipt DELIVERED/READ hanya terbaca selama aplikasi terhubung.
- Untuk kebutuhan bisnis formal/skala besar, gunakan **WhatsApp Business
  Platform (Cloud API resmi Meta)** yang memiliki batas, template, dan
  perlindungan sesuai kebijakan resmi.

---

## 📄 License

MIT — gunakan secara bertanggung jawab.
