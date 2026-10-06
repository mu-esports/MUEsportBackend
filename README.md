# MU Esport Staff

ระบบหลังบ้านสำหรับทีมงานชมรม MU Esport (ไม่รวม Academy) — หน้าเว็บ React + Worker บน Cloudflare + ฐานข้อมูลกลาง Cloudflare D1
ทีมงานเข้าสู่ระบบด้วย Google ใช้ข้อมูลสมาชิกและกำหนดการชุดเดียวกันจากทุกอุปกรณ์ และสร้าง/แก้เอกสารข้อความที่เก็บเป็น Google Docs ในบัญชีของชมรม

> สถานะรอบนี้: โค้ด ค่าตั้ง และคู่มือพร้อมสำหรับ deploy แต่ **ยังไม่ได้ deploy และยังไม่ได้ทดสอบกับ Google จริง**
> เพราะยังไม่มี Google OAuth credentials, Cloudflare account/database ID และ domain ที่ยืนยัน ดูหัวข้อ [ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ](#ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ)

## สารบัญ

1. [สิ่งที่ระบบทำได้](#สิ่งที่ระบบทำได้)
2. [เริ่มใช้ในเครื่อง](#เริ่มใช้ในเครื่อง)
3. [คำสั่งทั้งหมด](#คำสั่งทั้งหมด)
4. [โครงสร้างโครงการ](#โครงสร้างโครงการ)
5. [ค่าตั้งและค่าลับ](#ค่าตั้งและค่าลับ)
6. [ตั้งค่า Google Cloud](#ตั้งค่า-google-cloud)
7. [Deploy ขึ้น Cloudflare](#deploy-ขึ้น-cloudflare)
8. [Checklist ก่อน push และก่อน deploy](#checklist-ก่อน-push-และก่อน-deploy)
9. [การทดสอบ](#การทดสอบ)
10. [หลักการออกแบบที่ควรรู้](#หลักการออกแบบที่ควรรู้)
11. [ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ](#ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ)

## หน้าตาและโครงหน้า (พอร์ทัล)

- แนวทาง Tactical Operations Hub: หัวเว็บกรมท่า `#0B1F3A` สีหลักน้ำเงิน `#1D4ED8` พื้น `#F4F7FB` เมนูซ้ายเป็นแผงขาวไอคอนสม่ำเสมอ หน้าที่เลือกเป็นพื้นน้ำเงินอ่อนพร้อมแถบซ้าย มุมเฉียงใช้เฉพาะเครื่องหมายแบรนด์ ไอคอนทางลัด และขีดหน้าหัวข้อ ทั้งโครงกว้างไม่เกิน 1800px
- หน้าแรก: ทางลัด → สรุปสมาชิก → กำหนดการถัดไป 5 รายการและสถานะแหล่งข้อมูล → ปฏิทินเดือน ทางลัดใช้รายการเดียวกับเมนู (`src/components/nav.ts`) จึงเห็นเฉพาะหน้าที่โหมดและสิทธิ์นั้นเปิดได้
- ปฏิทินหน้าแรกและหน้าปฏิทินใช้ component เดียวกัน (`src/components/CalendarView.tsx`) และข้อมูลจาก store เดียวกัน หน้าแรกไม่มี dialog หรือการเขียนข้อมูล กดกำหนดการแล้วไป `/calendar?event=<id>`
- breakpoint: ≥1280 เมนู 248px (≥1700 เป็น 264px) · 1024–1279 เมนู 216px · <1024 เมนูเป็นปุ่มเปิดปิดบนหัวเว็บ (ต้องตรงกันระหว่าง `styles.css` กับ `DESKTOP_QUERY` ใน `Layout.tsx`) · <768 ทางลัด 2 คอลัมน์และปฏิทินเริ่มที่มุมมองรายการ
- บัญชีและปุ่มออกจากระบบ: จอกว้างอยู่บนหัวเว็บ จอแคบอยู่ในเมนู พฤติกรรมออกจากระบบเหมือนเดิมทุกประการ
- ข้อความเตือนอยู่ในแนวเนื้อหาเสมอ ไม่ลอยทับ: ออกจากระบบไม่สำเร็จแสดงเป็นแถบเหนือแผงหลัก (จอแคบแสดงในเมนูขณะเมนูเปิด) ส่วนแถบเซสชันหมดอายุเกาะด้านบนเป็นก้อนเดียวกับหัวเว็บ โดย `Layout.tsx` วัดความสูงจริงของก้อนนี้เป็น `--sticky-height` ให้ CSS ใช้เว้นระยะ
- ธีมสว่าง/มืด: สวิตช์บนหัวเว็บ ค่าเริ่มต้นสว่าง จำเฉพาะอุปกรณ์ใน localStorage key `mu-esport-staff:theme:v1` (แยกจากข้อมูลสมาชิก/กำหนดการ/session) สีทั้งหมดเป็น CSS variables ต้นไฟล์ `src/styles.css`

## สิ่งที่ระบบทำได้

| ส่วน | สถานะ |
| --- | --- |
| เข้าสู่ระบบทีมงานด้วย Google (OIDC) สิทธิ์ `staff` / `admin` ตรวจที่ server | พร้อม (ต้องตั้งค่า Google client ก่อน) |
| สมาชิกและกำหนดการ ใช้ร่วมกันผ่าน D1 กันการเขียนทับด้วย version | พร้อม |
| หน้า “ทีมงาน”: ผู้ดูแลเพิ่ม/เปลี่ยน/ถอนสิทธิ์ด้วยอีเมล | พร้อม |
| เชื่อมบัญชี Google ของชมรม (`muesport2567@gmail.com` เท่านั้น) | พร้อม (ต้องตั้งค่า Google client + กุญแจเข้ารหัส) |
| หน้า “เอกสาร”: สร้างและแก้เอกสารข้อความพื้นฐาน เก็บเป็น Google Docs | พร้อมในโค้ด ตรวจกับ Google จำลองแล้ว **ยังไม่ได้ตรวจกับ Google จริง** |
| Google Sheets / Google Calendar | พักไว้: แสดง “ยังไม่ได้เลือกชีต” / “ยังไม่ได้เลือกปฏิทิน” มีจุดต่อใน `worker/providers.ts` ยังไม่อ่านหรือเขียนข้อมูล และยังไม่ขอสิทธิ์ |
| Google Forms / Excel | ยังไม่เปิดใช้ |
| หน้าปฏิทิน | เป็น “กำหนดการในระบบ” (D1) ไม่ใช่ Google Calendar |

ข้อมูลจริงเริ่มจากว่าง ไม่มีการใส่ข้อมูลตัวอย่างหรือย้ายข้อมูลจากเบราว์เซอร์เข้า D1 อัตโนมัติ

## เริ่มใช้ในเครื่อง

ต้องมี Node.js 22 ขึ้นไป (พัฒนาและตรวจด้วย v24.19.0)

```bash
npm install

# 1) สร้างฐานข้อมูล D1 ในเครื่อง (เก็บใน .wrangler/ ไม่แตะ Cloudflare)
npm run db:migrate:local            # รันซ้ำทุกครั้งที่มีไฟล์ใหม่ใน migrations/

# 2) ใส่ค่า Google สำหรับเครื่องนี้ (ดูหัวข้อ "ตั้งค่า Google Cloud")
cp .dev.vars.example .dev.vars      # Windows PowerShell: Copy-Item .dev.vars.example .dev.vars
#    แล้วแก้ .dev.vars ใส่ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY

# 3) เปิดเว็บ + Worker พร้อมกัน
npm run dev                         # http://localhost:5173
```

- ถ้ายังไม่มี `.dev.vars` เว็บยังเปิดได้ แต่หน้าเข้าสู่ระบบจะบอกว่ายังไม่ได้ตั้งค่า และเข้าสู่ระบบไม่ได้ (ไม่มีทางลัดข้ามการเข้าสู่ระบบ)
- คนแรกที่เข้าได้คือบัญชี `muesport2567@gmail.com` (เป็นผู้ดูแลโดยอัตโนมัติเมื่อ Google ยืนยันอีเมลนี้) จากนั้นเพิ่มทีมงานที่หน้า “ทีมงาน”

**โหมดข้อมูลตัวอย่าง** (ไม่ต้องตั้งค่าอะไร ใช้ดูหน้าจอและตรวจ regression ของ UI เท่านั้น):

```bash
npm run dev:demo                    # http://localhost:5174
```

โหมดนี้เก็บข้อมูลตัวอย่างใน localStorage ของเบราว์เซอร์ มีแถบ “ข้อมูลตัวอย่าง” กำกับ ไม่มีเอกสาร/ทีมงาน/การเข้าสู่ระบบ
ใช้ repository แยกจากโหมดจริง (`src/data/repository.ts`) และ build สำหรับ deploy เป็นโหมดจริงเสมอ โหมดจริงไม่มีการสลับไปใช้ข้อมูลตัวอย่างเมื่อระบบกลางหรือ Google ล้มเหลว

## คำสั่งทั้งหมด

| คำสั่ง | ทำอะไร |
| --- | --- |
| `npm run dev` | เว็บ + Worker + D1 local ที่ `http://localhost:5173` |
| `npm run dev:demo` | โหมดข้อมูลตัวอย่างที่ `http://localhost:5174` |
| `npm run typecheck` | ตรวจ type ของหน้าเว็บ, ไฟล์ config, Worker และชุดทดสอบ |
| `npm test` | ทดสอบ Worker ใน Workers runtime กับ D1 local และ Google จำลอง |
| `npm run build` | typecheck + build (ค่าตั้งของเครื่อง ใช้กับ `npm run preview` และ dry-run) |
| `npm run build:staging` / `npm run build:production` | build ด้วยค่าตั้งของ environment นั้นใน `wrangler.jsonc` |
| `npm run check:dry-run` | `wrangler deploy --dry-run` ตรวจ bundle และ binding โดยไม่ deploy (ต้อง build ก่อน) |
| `npm run preview` | รันผล build ด้วย Workers runtime ในเครื่องที่ `http://localhost:4173` |
| `npm run db:migrate:local` | ใช้ migrations กับ D1 ในเครื่อง |
| `npm run check:ui` | ตรวจ UI โหมดตัวอย่างในเบราว์เซอร์จริง (เปิด `npm run dev:demo` ไว้ก่อน) |
| `npm run check:ui:live` | ตรวจ UI โหมดจริงในเบราว์เซอร์จริง (สคริปต์เปิด/ปิด dev server เองที่พอร์ต 5183 และใช้ฐานข้อมูลทดสอบแยกใน `.wrangler/ui-test-state`) |
| `npm run types` | สร้าง type ของ Workers runtime ใหม่หลังแก้ `wrangler.jsonc` |

## โครงสร้างโครงการ

```
wrangler.jsonc            ค่าตั้ง Worker: local (บนสุด), env.staging, env.production
migrations/               โครงสร้าง D1 เรียงตามเลข (0001 เริ่มต้น, 0002 ควบคุมงานสร้างเอกสาร) ใช้ซ้ำได้ทั้ง local และ remote
.dev.vars.example         ตัวอย่างค่าลับสำหรับเครื่อง (ไฟล์จริง .dev.vars ถูก gitignore)
.github/workflows/ci.yml  ตรวจ type, test, build, dry-run (ไม่ใช้ secret ไม่ deploy)

worker/                   โค้ดฝั่ง server (Cloudflare Worker, TypeScript, Web APIs)
  index.ts                จัดเส้นทาง /api/* และ /auth/* ที่เหลือส่งให้ static assets
  auth.ts                 เข้าสู่ระบบ, callback, ออกจากระบบ, bootstrap ผู้ดูแล
  session.ts              session cookie, ตรวจสิทธิ์, CSRF, audit log
  google.ts               OAuth, ตรวจ id_token, token ของบัญชีชมรม (เข้ารหัส AES-GCM)
  members.ts events.ts    API สมาชิกและกำหนดการ (แก้ทีละรายการ + version + กันสร้างซ้ำ)
  users.ts                API จัดการบัญชีทีมงาน (เฉพาะผู้ดูแล)
  documents.ts            API เอกสาร: สร้าง/อ่าน/บันทึก/งานค้าง
  docs.ts                 ตัวแปลงข้อความ ↔ โครงสร้าง Google Docs (ฟังก์ชันล้วน)
  sources.ts providers.ts สถานะการเชื่อม และจุดต่อของ Sheets/Calendar
  crypto.ts http.ts validation.ts env.ts

src/                      หน้าเว็บ (React)
  mode.ts                 โหมด live / demo
  api/client.ts           เรียก API พร้อม CSRF token และ key กันสร้างซ้ำ
  auth/                   AuthProvider, RequireAuth (รวมกรณีเซสชันหมดอายุ)
  data/                   repository (API และตัวอย่าง), store, ชนิดข้อมูล
  pages/                  ภาพรวม สมาชิก ปฏิทิน เอกสาร แหล่งข้อมูล ทีมงาน เข้าสู่ระบบ
  components/             Layout, Dialog, Toast, ui

test/                     ชุดทดสอบ Worker (vitest + @cloudflare/vitest-pool-workers)
scripts/                  ชุดตรวจ UI และตัวช่วยสร้างข้อมูลทดสอบใน D1 local
screenshots/              ภาพจากชุดตรวจ UI (ข้อมูลทดสอบเท่านั้น)
```

### เส้นทางของระบบ

| เส้นทาง | ผู้จัดการ |
| --- | --- |
| `/api/*` | Worker — ตอบ JSON เสมอ (รวม 404) และ `Cache-Control: no-store` |
| `/auth/login`, `/auth/google/callback`, `/auth/logout` | Worker |
| อื่น ๆ เช่น `/members`, `/calendar?event=<id>`, `/documents/<id>` | static assets แบบ SPA (refresh ได้) |

`wrangler.jsonc` ตั้ง `run_worker_first: ["/api/*", "/auth/*"]` เพื่อให้สองกลุ่มแรกวิ่งเข้า Worker แม้เปิด URL ตรงจากเบราว์เซอร์

## ค่าตั้งและค่าลับ

| ชื่อ | ชนิด | อยู่ที่ไหน | ใช้ทำอะไร |
| --- | --- | --- | --- |
| `CLUB_GOOGLE_EMAIL` | ค่าตั้ง (ไม่ลับ) | `vars` ใน `wrangler.jsonc` | บัญชีชมรม: ผู้ดูแลคนแรก และบัญชีเดียวที่เชื่อม Google ได้ ค่าปัจจุบัน `muesport2567@gmail.com` |
| `GOOGLE_CLIENT_ID` | ค่าตั้ง (ไม่ลับ) | เครื่อง: `.dev.vars` · Cloudflare: `vars` ของ environment นั้นใน `wrangler.jsonc` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | **ค่าลับ** | เครื่อง: `.dev.vars` · Cloudflare: Worker Secret | OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | **ค่าลับ** | เครื่อง: `.dev.vars` · Cloudflare: Worker Secret | กุญแจ AES-256-GCM (32 ไบต์ base64) เข้ารหัส token ของ Google ใน D1 |
| `DB` | binding | `d1_databases` ใน `wrangler.jsonc` | ฐานข้อมูล D1 |
| `ASSETS` | binding | `assets` ใน `wrangler.jsonc` | ไฟล์หน้าเว็บ |

- สร้างกุญแจ: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- แต่ละ environment (เครื่อง / staging / production) ใช้ **กุญแจคนละค่า ฐานข้อมูลคนละตัว และ OAuth client secret ของตัวเอง**
- ห้ามใส่ค่าลับในตัวแปรที่ขึ้นต้นด้วย `VITE_` (จะถูกฝังในไฟล์ที่ส่งให้เบราว์เซอร์) โครงการนี้ไม่ใช้ตัวแปร `VITE_` เลย
- ถ้าเปลี่ยน `TOKEN_ENCRYPTION_KEY` token ที่เก็บไว้จะถอดรหัสไม่ได้ ต้องให้ผู้ดูแลกด “เชื่อมใหม่” ที่หน้าแหล่งข้อมูล
- ค่าที่ยังเป็น `REPLACE_WITH_...` หรือว่าง ระบบถือว่า “ยังไม่ได้ตั้งค่า” และบอกในหน้าเว็บ ไม่มีสถานะเชื่อมแล้วปลอม

## ตั้งค่า Google Cloud

ทำด้วยบัญชี Google ที่เป็นเจ้าของโครงการ (แนะนำบัญชีชมรม) ที่ <https://console.cloud.google.com/>
การเชื่อม Google ที่ใช้ในเครื่องมืออื่น (เช่น Codex) ไม่เกี่ยวกับเว็บไซต์นี้ เว็บไซต์ต้องมี OAuth client ของตัวเอง

1. **สร้างโครงการ** (หรือเลือกโครงการของชมรม)
2. **เปิด API** ที่ APIs & Services → Library: `Google Drive API` และ `Google Docs API`
3. **หน้าจอขอความยินยอม (OAuth consent screen / Google Auth Platform)**
   - Audience: **External** (บัญชี `@gmail.com` ใช้ Internal ไม่ได้)
   - ขณะสถานะเป็น **Testing** ให้เพิ่ม Test users: `muesport2567@gmail.com` **และบัญชี Google ของทีมงานทุกคนที่จะเข้าสู่ระบบ** (ในสถานะ Testing เฉพาะ test users เท่านั้นที่เข้าได้)
   - Scopes ที่ระบบขอจริง: `openid`, `email`, `profile` (เข้าสู่ระบบ) และ `https://www.googleapis.com/auth/drive.file` (เฉพาะตอนผู้ดูแลเชื่อมบัญชีชมรม) ไม่ขอ Gmail, ทั้ง Drive, Sheets หรือ Calendar
4. **สร้าง OAuth client** ที่ Credentials → Create credentials → OAuth client ID → **Web application**
   - Authorized JavaScript origins และ Authorized redirect URIs ต้องตรงกับที่โค้ดใช้ (callback เดียวใช้ทั้งเข้าสู่ระบบและเชื่อม Google):

     | ที่ใช้ | Origin | Redirect URI |
     | --- | --- | --- |
     | เครื่อง | `http://localhost:5173` | `http://localhost:5173/auth/google/callback` |
     | production (ตัวอย่าง) | `https://<โดเมนของเว็บ>` | `https://<โดเมนของเว็บ>/auth/google/callback` |
     | staging (ตัวอย่าง) | `https://<โดเมน staging>` | `https://<โดเมน staging>/auth/google/callback` |

   - `<โดเมนของเว็บ>` คือโดเมนที่ผู้ใช้เปิดจริง เช่น `mu-esport-staff.<subdomain>.workers.dev` หรือโดเมนของชมรม ถ้าเปิดได้หลายโดเมนต้องใส่ทุกโดเมน
   - แนะนำแยก OAuth client ของเครื่อง / staging / production
5. นำ **Client ID** และ **Client secret** ไปใส่ตามหัวข้อ [ค่าตั้งและค่าลับ](#ค่าตั้งและค่าลับ)

**ข้อจำกัดของสถานะ Testing:** Google ระบุว่า refresh token ของแอปแบบ External ที่ยังเป็น Testing และขอ scope นอกเหนือจากชื่อ อีเมล และโปรไฟล์ จะหมดอายุใน 7 วัน
ระบบนี้ขอ `drive.file` จึงเข้าข่าย: การเชื่อมบัญชีชมรมจะเข้าสถานะ “ต้องเชื่อมใหม่” ทุกประมาณ 7 วันจนกว่าจะเปลี่ยนสถานะเป็น **In production**
ก่อนใช้งานจริงต้องวางขั้นเผยแพร่แอปและทำตามเงื่อนไขการตรวจสอบ (verification) ที่ Google กำหนด ณ เวลานั้น — เอกสารนี้ไม่รับรองว่าการเชื่อมจะอยู่ได้ตลอด
อ้างอิง: <https://developers.google.com/identity/protocols/oauth2#expiration>

## Deploy ขึ้น Cloudflare

ผู้ดูแลโครงการทำเองทั้งหมด (โค้ดนี้ไม่ได้ login, สร้างทรัพยากร หรือ deploy ให้) แต่ละ environment คือ Worker คนละตัว ฐานข้อมูลคนละตัว และค่าลับคนละชุด:

| Environment | ชื่อ Worker | ฐานข้อมูล D1 | build ด้วย |
| --- | --- | --- | --- |
| เครื่อง | — | D1 local ใน `.wrangler/` | `npm run dev` |
| staging | `mu-esport-staff-staging` | `mu-esport-staff-staging` | `npm run build:staging` |
| production | `mu-esport-staff` | `mu-esport-backend-production` | `npm run build:production` |

> โครงการใช้ Cloudflare Vite plugin: environment ถูกเลือก **ตอน build** (สคริปต์ตั้ง `CLOUDFLARE_ENV` ให้) แล้ว `wrangler deploy` ใช้ค่าตั้งที่ build สร้างไว้ใน `dist/` จึง **ไม่ใส่ `--env` ตอน deploy**
> ถ้า build ด้วย `npm run build` เฉย ๆ จะได้ค่าตั้งของเครื่อง (database ID ปลอม) ซึ่ง deploy ไม่ผ่าน เป็นการกันพลาดโดยตั้งใจ

### ขั้นที่ 1 — เตรียมครั้งแรก (ทำจากเครื่อง ต่อ environment)

ตัวอย่างสำหรับ production (staging ทำเหมือนกันโดยเปลี่ยนชื่อ):

```bash
npx wrangler login

# 1. สร้างฐานข้อมูลเฉพาะกรณีที่ยังไม่มี แล้วคัดลอก database_id ที่ได้
# โครงการนี้สร้าง mu-esport-backend-production ผ่าน dashboard แล้ว จึงข้ามคำสั่งนี้
npx wrangler d1 create mu-esport-backend-production
```

2. แก้ `wrangler.jsonc` ส่วน `env.production`:
   - `d1_databases[0].database_name` และ `database_id` ← ชื่อและ ID ของฐานข้อมูลจริง (production ของโครงการนี้ใส่ไว้แล้ว)
   - `vars.GOOGLE_CLIENT_ID` ← Client ID ของ production (แทน `REPLACE_WITH_PRODUCTION_GOOGLE_CLIENT_ID`)

```bash
# 3. สร้างตารางในฐานข้อมูลจริง (ไม่ลบข้อมูลเดิม ใช้เฉพาะ migration ที่ยังไม่เคยใช้)
npx wrangler d1 migrations apply DB --remote --env production

# 4. deploy ครั้งแรก
npm run build:production
npx wrangler deploy

# 5. ตั้งค่าลับของ Worker (วางค่าเมื่อถูกถาม ไม่ต้องใส่ในไฟล์ใด)
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
npx wrangler secret put TOKEN_ENCRYPTION_KEY --env production
```

6. เพิ่ม redirect URI ของโดเมนจริงใน Google Cloud (หัวข้อก่อนหน้า)
7. เปิดเว็บ → เข้าสู่ระบบด้วย `muesport2567@gmail.com` → หน้า “แหล่งข้อมูล” → “เชื่อมบัญชี Google ของชมรม” → หน้า “ทีมงาน” เพิ่มอีเมลทีมงาน

### ขั้นที่ 2 — deploy ครั้งต่อไป: Workers Builds เชื่อม GitHub (ทางหลัก)

ที่ Cloudflare dashboard → Workers & Pages → เลือก Worker → Settings → Builds → Connect repository แล้วตั้งค่า:

| ช่อง | Worker `mu-esport-staff` (production) | Worker `mu-esport-staff-staging` |
| --- | --- | --- |
| Production branch | `main` | `staging` (หรือ branch ที่ใช้ทดสอบ) |
| Build command | `npm run build:production` | `npm run build:staging` |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy` |
| Builds for non-production branches | **ปิด** | ปิด หรือเปิดเฉพาะเมื่อเข้าใจว่าจะใช้ฐานข้อมูล staging |

- ปิด build ของ branch อื่นบน Worker production เพื่อไม่ให้ preview ของ pull request ใช้ฐานข้อมูล ค่าลับ และการเชื่อม Google ของ production
- Workers Builds **ไม่รัน migrations ให้** เมื่อมีไฟล์ใหม่ใน `migrations/` ให้รันเองก่อน deploy โค้ดที่ต้องใช้:
  `npx wrangler d1 migrations apply DB --remote --env production`
- ค่าลับที่ตั้งด้วย `wrangler secret put` อยู่กับ Worker ไม่หายเมื่อ deploy ใหม่ และไม่ต้องใส่ใน Build variables
- เอกสาร: <https://developers.cloudflare.com/workers/ci-cd/builds/>

**ทางสำรอง (deploy จากเครื่อง):** `npm run build:production` แล้ว `npx wrangler deploy` เหมือนขั้นที่ 1 ข้อ 4

### เปลี่ยนโครงสร้างฐานข้อมูลภายหลัง

เพิ่มไฟล์ใหม่ใน `migrations/` (เช่น `0002_xxx.sql`) เท่านั้น ไม่แก้ไฟล์เดิม ไม่มีคำสั่งรีเซ็ตฐานข้อมูลจริงในโครงการนี้
ลำดับ: ใช้กับเครื่อง (`npm run db:migrate:local`) → staging (`--remote --env staging`) → ตรวจ → production (`--remote --env production`)

## Checklist ก่อน push และก่อน deploy

**ก่อน push ขึ้น GitHub ครั้งแรก**

- [ ] `git init` แล้วตรวจ `git status` ว่า **ไม่มี** `.dev.vars`, `.env*`, `.wrangler/`, ไฟล์ `client_secret*.json` หรือ token ใด ๆ (ทั้งหมดอยู่ใน `.gitignore` แล้ว)
- [ ] `wrangler.jsonc` ไม่มีค่าลับ (มีได้แค่ `GOOGLE_CLIENT_ID` และ `database_id` ซึ่งไม่ใช่ค่าลับ)
- [ ] โฟลเดอร์ `screenshots/` มีเฉพาะภาพจากข้อมูลทดสอบ (ภาพจากข้อมูลจริงให้เก็บใน `screenshots-private/` ซึ่งถูก ignore)
- [ ] `npm run typecheck`, `npm test`, `npm run build`, `npm run check:dry-run` ผ่าน
- [ ] ตั้ง repository เป็น private ถ้าไม่ต้องการเปิดเผยโครงสร้างระบบ

**ก่อน deploy production ครั้งแรก**

- [ ] สร้าง D1 และใส่ `database_id` จริงใน `env.production` (ไม่มี `REPLACE_WITH_` เหลือ)
- [ ] ใส่ `GOOGLE_CLIENT_ID` ของ production ใน `env.production.vars`
- [ ] รัน migrations แบบ `--remote --env production` (ตอนนี้มี 2 ไฟล์: `0001`, `0002` คำสั่งเดียวใช้ทุกไฟล์ที่ยังไม่เคยใช้)
- [ ] ตั้ง Worker Secrets ครบสองตัว: `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (กุญแจใหม่ ไม่ใช้ค่าเดียวกับเครื่อง)
- [ ] Google Cloud: เปิด Drive API + Docs API, redirect URI ของโดเมนจริงตรงตัวอักษร, เพิ่ม test users (ถ้ายังเป็น Testing)
- [ ] build ด้วย `npm run build:production` (ไม่ใช่ `npm run build`)

**หลัง deploy (ตรวจด้วยมือ เพราะยังไม่เคยตรวจกับ Google จริง)**

- [ ] เปิด `https://<โดเมน>/api/session` ได้ JSON ที่ `authConfigured: true`
- [ ] เข้าสู่ระบบด้วยบัญชีชมรมได้ และบัญชีที่ไม่ได้เพิ่มสิทธิ์เห็นหน้า “ไม่มีสิทธิ์เข้าใช้งาน”
- [ ] หน้า “แหล่งข้อมูล”: เชื่อมบัญชีชมรม → สถานะ “เชื่อมแล้ว” และลองเชื่อมด้วยบัญชีอื่นแล้วถูกปฏิเสธ
- [ ] หน้า “เอกสาร”: สร้าง **เอกสารทดสอบใหม่** (ไม่ใช้ไฟล์เดิมของชมรม) ใส่ภาษาไทย ขึ้นบรรทัดใหม่ และ emoji → เปิดใน Google Docs ตรวจว่าตรงกัน → แก้ใน Google Docs → กลับมาบันทึกจากเว็บแล้วเห็นข้อความ conflict
- [ ] เปิดจากมือถือและคอมพิวเตอร์ด้วยคนละบัญชี เพิ่มสมาชิกจากเครื่องหนึ่งแล้ว refresh อีกเครื่องเห็นข้อมูลเดียวกัน

## การทดสอบ

| ชุด | คำสั่ง | ใช้อะไร | ครอบคลุม |
| --- | --- | --- | --- |
| Worker | `npm test` | Workers runtime (workerd) + D1 local ที่ใช้ migrations จริง + **Google จำลอง** (แทน `fetch` เฉพาะใน test) | สิทธิ์ทุกเส้นทาง, staff/admin, bootstrap ผู้ดูแล, คำขอสร้างเอกสารพร้อมกัน/lease หมด/ผลไม่แน่ชัด/นำงานออกขณะทำ (`test/document-races.test.ts`), session หมดอายุ/ออกจากระบบ/ถอนสิทธิ์, CSRF, validation, สอง session ใช้ฐานเดียวกัน, 409 เมื่อแก้จากข้อมูลเก่า, สร้างซ้ำไม่เกิดรายการซ้ำ, OAuth state/nonce/PKCE/บัญชีผิด/refresh token/invalid_grant, ค่าลับไม่หลุด, ตัวแปลง Google Docs (ไทย/ขึ้นบรรทัด/emoji/เอกสารว่าง/โครงสร้าง rich), revision conflict, สร้างเอกสารสำเร็จบางส่วนแล้วทำต่อ |
| UI โหมดจริง | `npm run check:ui:live` | Edge (Chromium) + WebKit ของ Playwright, `vite dev` + Worker + D1 local ทดสอบ | เข้าสู่ระบบ/ปฏิเสธสิทธิ์, ข้อมูลร่วมสอง session, conflict, retry ไม่ซ้ำ, เซสชันหมดอายุระหว่างแก้เอกสาร, ทีมงาน, แหล่งข้อมูล, หน้าเอกสารทุกสถานะ, 1440/1024/768/390/320 และแนวนอน, คีย์บอร์ด/focus/เมนู — ข้อที่ขึ้นต้นด้วย `[จำลอง]` ตอบ API เอกสารด้วยข้อมูลจำลองเพื่อดูหน้าจอ |
| UI โหมดตัวอย่าง | `npm run check:ui` | Edge (Chromium), `npm run dev:demo` | regression ของหน้าจอเดิมทั้งหมด |

- ผู้ใช้และ session สำหรับทดสอบถูกสร้างตรงในฐานข้อมูลทดสอบ (`test/helpers.ts`, `scripts/local-fixtures.mjs`) Worker **ไม่มี** เส้นทางข้ามการเข้าสู่ระบบ, token เริ่มต้น, endpoint ใส่ข้อมูลตัวอย่าง/รีเซ็ต หรือ Google จำลองในเส้นทางจริง (มี test ยืนยันว่าเส้นทางเหล่านี้ตอบ 404)
- ชุด UI ต้องมี Microsoft Edge (หรือตั้ง `BROWSER_CHANNEL=chrome`) และ WebKit ติดตั้งด้วย `npx playwright-core install webkit` ถ้าไม่มี WebKit ชุดตรวจจะข้ามส่วนนั้นและบอกไว้

## หลักการออกแบบที่ควรรู้

**ข้อมูลร่วมกัน**

- ทุกคำสั่งแก้ทีละรายการ (`PATCH /api/members/:id`) ไม่มีการเขียนข้อมูลทั้งชุด
- สมาชิก/กำหนดการมี `version` การแก้ต้องส่ง `expectedVersion` และ server ใช้ `UPDATE ... WHERE id = ? AND version = ?` คนที่แก้จากข้อมูลเก่าได้ `409` พร้อมค่าล่าสุด หน้าเว็บเก็บค่าที่กรอกไว้และมีปุ่ม “โหลดค่าล่าสุด”
- การสร้างส่ง header `Idempotency-Key` (ผูกกับผู้ใช้ + ชนิดคำสั่ง + ข้อมูล) ลองใหม่ด้วย key เดิมได้รายการเดิม
- หน้าเว็บแสดงว่าสำเร็จหลัง server ยืนยันเท่านั้น และดึงข้อมูลใหม่เมื่อบันทึกหรือกลับเข้าแท็บ อุปกรณ์อื่นเห็นผลเมื่อ refresh/กลับเข้าแท็บ — **ไม่ใช่ real time**

**ผู้ใช้และสิทธิ์**

- ตาราง `users` (ผู้เข้าสู่ระบบ) แยกจาก `members` (รายชื่อสมาชิกชมรม) บทบาทและสถานะของสมาชิกไม่มีผลกับสิทธิ์เข้าสู่ระบบ
- บัญชีชมรมเป็นผู้ดูแลหลักโดยอัตโนมัติ ถอนสิทธิ์ไม่ได้ ผู้ดูแลเปลี่ยนสิทธิ์ของตัวเองไม่ได้
- อีเมลที่เพิ่มไว้ถูกผูกกับบัญชี Google แรกที่ใช้เข้าสู่ระบบ (`sub`)
- session cookie `mu_session`: HttpOnly, SameSite=Lax, Secure บน HTTPS, อายุ 7 วัน, D1 เก็บเฉพาะ SHA-256 ของค่าใน cookie ถอนสิทธิ์หรือเปลี่ยนสิทธิ์จะลบ session ของคนนั้นทันที
- คำสั่งที่เปลี่ยนข้อมูลต้องมี `Origin` ของเว็บเองและ header `X-CSRF-Token` ที่ผูกกับ session

**Google**

- เข้าสู่ระบบ: Authorization Code + PKCE + state (ใช้ครั้งเดียว อายุ 10 นาที ผูกกับเบราว์เซอร์ด้วย cookie และผูกกับจุดประสงค์) + nonce ตรวจ `id_token` ด้วยกุญแจสาธารณะของ Google (ไลบรารี `jose`)
- เชื่อมบัญชีชมรม: เฉพาะผู้ดูแล, ต้องเป็นอีเมลชมรมที่ Google ยืนยัน, refresh token เข้ารหัส AES-256-GCM (IV ใหม่ทุกครั้ง) ใน D1
- `invalid_grant` → สถานะ “ต้องเชื่อมใหม่” ไม่สลับบัญชี ไม่ใช้ข้อมูลตัวอย่างแทน
- ออกจากระบบของทีมงานไม่ตัดการเชื่อม “ตัดการเชื่อม” เป็นคำสั่งแยกของผู้ดูแล ไม่ลบไฟล์ใน Google และไม่ลบข้อมูลใน D1
- ออกจากระบบ: หน้าเว็บไปหน้าเข้าสู่ระบบเฉพาะเมื่อ server ยืนยันว่า session ถูกยกเลิกแล้ว ถ้าคำขอล้มเหลวจะถาม `/api/session` ว่ายังมี session อยู่หรือไม่
  ยังอยู่ = แจ้งว่าไม่สำเร็จให้ลองใหม่ (ร่างที่ยังไม่บันทึกไม่ถูกทิ้ง) · ไม่อยู่แล้ว = ถือว่าออกแล้ว · ถามไม่ได้ = แจ้งว่ายืนยันไม่ได้

**เอกสาร**

- เนื้อหาอยู่ใน Google Docs เท่านั้น D1 เก็บรายการ (ชื่อ ผู้แก้ สถานะ ลิงก์) และเก็บเนื้อหาชั่วคราวเฉพาะระหว่างงานสร้างที่ยังไม่เสร็จ
- จัดการเฉพาะเอกสารที่สร้างผ่านเว็บ (สิทธิ์ `drive.file`) ไม่ดึงเอกสารอื่นใน Drive
- editor รองรับข้อความพื้นฐาน: ย่อหน้า ขึ้นบรรทัดใหม่ จำกัด 50,000 หน่วย UTF-16
- **ชื่อเอกสารตั้งได้ตอนสร้างเท่านั้น** หลังสร้างแล้วช่องชื่อในเว็บเป็นอ่านอย่างเดียว และ server ปฏิเสธคำขอเปลี่ยนชื่อ (`title_change_not_supported`)
  เหตุผล: การเปลี่ยนชื่อเป็นคำสั่งของ Drive ซึ่งไม่มีเงื่อนไข revision ให้ Google ตรวจ (`requiredRevisionId` ใช้ได้กับ Docs `batchUpdate` เท่านั้น) จึงกันการเขียนทับชื่อที่คนอื่นเพิ่งเปลี่ยนไม่ได้
  เปลี่ยนชื่อใน Google Docs ได้ตามปกติ รายการในเว็บจะตามชื่อจริงเมื่อเปิดหรือบันทึกเอกสารนั้น
- เอกสารที่มีตาราง รูป หลายแท็บ หัว/ท้ายกระดาษ เชิงอรรถ รายการ หัวข้อ การจัดรูปแบบตัวอักษร หรือคำแนะนำค้าง จะเปิดอ่านอย่างเดียวพร้อมเหตุผล และไม่ถูกเขียนทับ
- บันทึกแก้เฉพาะช่วงที่ต่าง ด้วย `writeControl.requiredRevisionId` ถ้าเอกสารถูกแก้จากที่อื่น Google จะปฏิเสธและหน้าเว็บให้ตรวจฉบับล่าสุดโดยเก็บสิ่งที่พิมพ์ไว้
- “บันทึกแล้ว” แสดงหลังอ่านกลับจาก Google แล้วตรงกับที่ส่ง
- ถ้า Google ตอบ 5xx หรือคำตอบไม่กลับมาหลังส่งคำสั่งบันทึก ระบบรายงานว่า **ไม่ทราบผล** (`save_outcome_unknown`) ไม่บอกว่าไม่มีอะไรเปลี่ยน
  หน้าเว็บเก็บสิ่งที่พิมพ์ไว้และให้กด “ตรวจฉบับล่าสุดจาก Google Docs” ก่อนบันทึกซ้ำ ถ้าเขียนสำเร็จแต่อ่านกลับไม่ได้จะรายงาน `saved_unverified`
- สร้างเอกสารทำเป็นขั้น (สร้างไฟล์ → เขียนเนื้อหา → อ่านกลับ → ลงทะเบียน) งานค้างดูได้ที่หน้าเอกสาร การกันไฟล์ซ้ำมีสามชั้น (ตาราง `document_operations`):
  1. **lease ใน D1** — คำขอต้อง claim งานด้วย `UPDATE` แบบมีเงื่อนไขก่อนเรียก Google ทั้งการสร้างและการทำต่อใช้ชุดเดียวกัน คำขอซ้ำที่มาระหว่างนั้นรอผลเดิมสูงสุด 4 วินาที แล้วได้เอกสารเดิม หรือได้ `operation_in_progress` (lease อายุ 120 วินาที ต่ออายุก่อนทุกขั้น คำขอไป Google จำกัด 20 วินาที)
  2. **เครื่องหมายก่อนสร้าง** (`create_attempted_at`) — บันทึกก่อนส่งคำสั่งสร้างไฟล์ และล้างเฉพาะเมื่อ Google ตอบ 4xx ชัดเจนว่าไม่ได้สร้าง
     ถ้าเครื่องหมายค้างโดยไม่มี id ของไฟล์ = **ไม่ทราบผล** ระบบจะค้นหาไฟล์เดิมจากป้าย `appProperties` เท่านั้น **ไม่สร้างใหม่เอง** แม้ค้นไม่พบ (ไฟล์ใหม่อาจยังไม่ปรากฏในผลค้นหา) และแม้ lease หมดระหว่างรอ Google
     หลัง 2 นาที ผู้ใช้ยืนยันให้สร้างใหม่ได้จากหน้าเอกสาร หลังตรวจ Google Drive เองแล้ว (บันทึกใน `audit_log`)
  3. **เงื่อนไขตอนเขียนและลงทะเบียน** — เขียนเนื้อหาเฉพาะเมื่อไฟล์ยังว่างและใช้ `requiredRevisionId` การลงทะเบียนใน `documents` ทำได้เฉพาะคำขอที่ยังถือ lease คำขอที่ค้างมาช้าจึงเขียนซ้ำหรือลงทะเบียนซ้ำไม่ได้
- “นำออกจากรายการ” ทำไม่ได้ขณะงานกำลังทำ และไม่ลบแถวของงาน (เก็บ id ไฟล์/เครื่องหมายไว้เป็นหลักฐาน) key เดิมจะไม่เริ่มงานใหม่เงียบ ๆ
- ไม่มีการแชร์ไฟล์ เปลี่ยนสิทธิ์ไฟล์ หรือลบไฟล์จากเว็บ ปุ่ม “เปิดใน Google Docs” ใช้สิทธิ์ Google ของผู้ใช้เอง

**log**: Worker log เฉพาะรหัสข้อผิดพลาดและเส้นทาง ไม่ log token, authorization code, cookie, เนื้อหาเอกสาร หรือข้อมูลติดต่อสมาชิก

## ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ

- **ยังไม่ได้ตรวจกับ Google จริง**: หน้าขอความยินยอมของ Google, การแลก token จริง, การสร้าง/แก้ Google Docs จริง, รูปแบบคำตอบจริงของ Docs API สำหรับไฟล์ที่สร้างใหม่ ทั้งหมดตรวจกับ Google จำลองเท่านั้น
  ความเสี่ยงที่รู้: ถ้า Google ใส่รูปแบบเริ่มต้นบางอย่างในเอกสารใหม่ที่ตัวตรวจถือว่าเป็น “การจัดรูปแบบ” เอกสารจะถูกเปิดแบบอ่านอย่างเดียว (ปลอดภัยแต่ใช้ไม่ได้) ต้องตรวจตอน smoke test และปรับ `worker/docs.ts`
- **ยังไม่ได้ deploy**: ตรวจแค่ `wrangler deploy --dry-run` และรันผล build ด้วย Workers runtime ในเครื่อง (`npm run preview`) ยังไม่ได้ตรวจบน Cloudflare จริง
- ตรวจ UI ด้วย Edge (Chromium) และ WebKit ของ Playwright บน Windows ที่ขนาดจอจำลอง **ไม่ได้ตรวจบน iPhone, Android, iPad หรือ Safari จริง** แป้นพิมพ์บนจอและการแตะจริงยังไม่ได้ตรวจ
- ไม่ได้ตรวจกับโปรแกรมอ่านหน้าจอ
- ไม่ใช่ real time: อุปกรณ์อื่นเห็นการแก้เมื่อ refresh, กลับเข้าแท็บ หรือบันทึก
- รายการสมาชิก/กำหนดการ/เอกสารโหลดทั้งหมดครั้งเดียว ยังไม่มีการแบ่งหน้า (เหมาะกับข้อมูลขนาดชมรม)
- ไม่มีการลบสมาชิก กำหนดการ หรือเอกสารจากเว็บ
- เปลี่ยนชื่อเอกสารจากเว็บไม่ได้หลังสร้าง ต้องเปลี่ยนใน Google Docs
- งานสร้างเอกสารที่ “ไม่ทราบผล” ต้องให้คนตัดสินใจ: ระบบค้นหาไฟล์เดิมให้ แต่ถ้าค้นไม่พบจะไม่สร้างใหม่เอง การยืนยันสร้างใหม่โดยผู้ใช้ยังมีโอกาสเกิดไฟล์ซ้ำถ้าไฟล์เดิมมีอยู่จริงแต่ค้นไม่พบ
- ถ้า Worker หยุดกลางงานสร้าง งานนั้นทำต่อได้หลัง lease หมด (สูงสุด 120 วินาที)
- ยังไม่มี rate limit ของตัวเอง (พึ่งการป้องกันของ Cloudflare) และตาราง `idempotency_keys`, `oauth_states`, `sessions` ที่หมดอายุยังไม่มีงานล้างตามเวลา (state ที่หมดอายุถูกลบเมื่อมีการเข้าสู่ระบบครั้งถัดไป)
- เซสชันหมดอายุระหว่างแก้เอกสาร: ร่างอยู่ในหน่วยความจำของหน้าที่เปิดอยู่เท่านั้น ถ้าปิดหรือโหลดหน้าใหม่ร่างจะหาย
- ยังไม่ทำ PWA / ใช้งานออฟไลน์
