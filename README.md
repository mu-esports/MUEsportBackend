# MU Esport Staff

ระบบทีมงานและพอร์ทัลสมาชิกชมรม MU Esport (ไม่รวม Academy) — หน้าเว็บ React + Worker บน Cloudflare + ฐานข้อมูลกลาง Cloudflare D1
ทีมงานเข้าสู่ระบบด้วย Google จัดการข้อมูลและซิงค์กับ Google ของชมรม ส่วนสมาชิกใช้รหัสนักศึกษาและรหัสผ่าน ดูกิจกรรม ไฟล์ Google ของชมรม และข้อมูลของตนเอง โดยไม่ต้องเข้าสู่ Google เพื่อดูตัวอย่างไฟล์

> **สถานะ (แยกสิ่งที่ยืนยันแล้วกับสิ่งที่ยังไม่ได้ทดสอบจริง)**
> - **รุ่นบัญชีสมาชิกและคลังไฟล์ (`eb51800`) push เข้า `main` และ deploy แล้วเมื่อ 8 ตุลาคม 2569** ที่ `https://muesportbackend.muesport2567.workers.dev` ใช้ Worker `muesportbackend` และ D1 `mu-esport-backend-production` สำรองฐานข้อมูลและ apply migration `0005` ก่อนเผยแพร่
> - ยืนยันการ login ทั้ง `u` + ตัวเลขและตัวเลขล้วน เปลี่ยนรหัสครั้งแรก ยกเลิก session เดิม และแยกสิทธิ์สมาชิกบน Workers Free จริงแล้ว ใช้ Argon2id ใน browser Web Worker + keyed server verifier โดยไม่เปลี่ยนแผน ดู [ผลตรวจล่าสุด](REVIEW_MEMBER_PORTAL.md) และ [บัญชีสมาชิก คลังไฟล์ และขั้นเปิดใช้](MEMBER_ACCESS.md)
> - **บัญชีชมรมอนุญาต `drive.readonly` แล้ว** และแสดงรายการไฟล์จาก Google จริงได้ ส่วนการซิงค์ทะเบียนสมาชิกกับ Sheets และคำตอบ Forms ยังต้องเลือกแหล่งข้อมูลที่หน้าแหล่งข้อมูล การทดสอบอัตโนมัติใช้ Google จำลอง; การตรวจเว็บจริงบันทึกแยกจากผลชุดตรวจ
> - **คลังไฟล์แบบการ์ดภาพย่อ (`64d90b9`) push และเผยแพร่แล้ว** ตรวจรายการ ภาพย่อจาก Google จริง ตัวอย่าง HEIC และมุมมองมือถือไม่ล้นผ่าน ดู [ผลตรวจคลังไฟล์](REVIEW_LIBRARY_PREVIEW.md)
>   ก่อนเปิดใช้ต้องทำตาม [ขั้นตอนเปิดใช้ Google Sync](#ขั้นตอนเปิดใช้-google-sync) และ [Checklist ทดสอบกับ Google จริง](#checklist-ทดสอบกับ-google-จริง) ดูหัวข้อ [ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ](#ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ)

หน้าไฟล์ชมรมมีมุมมองการ์ดพร้อมภาพย่อและมุมมองรายการ ภาพย่อโหลดเฉพาะใกล้หน้าจอไม่เกิน 4 ภาพพร้อมกัน ไม่ดาวน์โหลดเอกสารเต็มเพื่อสร้างการ์ด กลับจากตัวอย่างใช้รายการในหน่วยความจำของผู้ใช้เดิมชั่วคราวพร้อมตรวจข้อมูลใหม่ ภาพย่อผ่าน Worker ซึ่งตรวจ session และสิทธิ์ Google ทุกครั้งก่อนใช้ cache ภายใน 5 นาที; ไม่ส่ง Google token หรือ URL ภาพส่วนตัวให้ browser ไฟล์ HEIC/Office/ชนิดอื่นที่ Google มีภาพย่อแสดงตัวอย่างขนาดย่อได้ พร้อมข้อความว่าการดูความละเอียดเต็มต้องเปิดต้นฉบับ หาก Google ไม่มีภาพย่อยังแสดงไอคอนชนิดไฟล์

รุ่นถัดมาเพิ่ม login ฟอร์มเดียว (พิมพ์ `google` เพื่อไป Google OAuth), หมวด Docs/Sheets/Forms, ลบบัญชีเข้าสู่ระบบโดยเก็บทะเบียนไว้, หน้า `/athletes` และรูปบุคคลร่วมกัน ใช้ migration `0006_account_revision_athletes_photos.sql` ก่อนใช้ Worker ใหม่ ดู [ผลตรวจและขั้นเผยแพร่](ROSTER_RELEASE.md)

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
| บัญชีสมาชิก: รหัสนักศึกษา + รหัสผ่าน, บังคับเปลี่ยนรหัสชั่วคราว, ตั้ง/รีเซ็ต/ปิดบัญชีโดย admin | ทำในเครื่องแล้ว ต้องตรวจแผน Workers ก่อน production; ดู `MEMBER_ACCESS.md` |
| พอร์ทัลสมาชิก: กิจกรรม ไฟล์ชมรม ข้อมูลตนเอง | แยกจากหลังบ้าน สมาชิกไม่มีสิทธิ์จัดการข้อมูล |
| คลังไฟล์ Google ทั้งบัญชี: ค้นหา กรอง โหลดเพิ่ม และ preview ผ่าน server | ต้องอนุญาต `drive.readonly` เพิ่ม; การทดสอบใช้ Google จำลอง |
| สมาชิกและกำหนดการ ใช้ร่วมกันผ่าน D1 กันการเขียนทับด้วย version | พร้อม |
| หน้า “ทีมงาน”: ผู้ดูแลเพิ่ม/เปลี่ยน/ถอนสิทธิ์ด้วยอีเมล | พร้อม |
| เชื่อมบัญชี Google ของชมรม (`muesport2567@gmail.com` เท่านั้น) | พร้อม (ต้องตั้งค่า Google client + กุญแจเข้ารหัส) |
| หน้า “ไฟล์ชมรม”: ดูตัวอย่างไฟล์และเปิดแก้ใน Google; สร้างเอกสารใหม่ด้วยชื่อและเปิดเขียนใน Google Docs | ทำในเครื่องแล้ว; editor ข้อความเดิมยังอยู่ที่ `/documents/:id/edit` เพื่อรักษางานเดิม |
| Docs: ตรวจฉบับใหม่ระหว่างเปิดหน้า รายการตามชื่อใน Google ผูกเอกสารเดิมผ่าน Picker | พร้อมในโค้ด ตรวจกับ Google จำลอง **ยังไม่ได้ตรวจกับ Google จริง** |
| หน้า “แหล่งข้อมูล” → พื้นที่ข้อมูลชมรม: สร้างชุดข้อมูลใหม่ / เลือกข้อมูลที่มีอยู่ / ย้ายข้อมูลเดิม / ยกเลิกการเชื่อม (เฉพาะผู้ดูแล) | พร้อมในโค้ด ตรวจกับ Google จำลอง **ยังไม่ได้ตรวจกับ Google จริง** |
| Google Sheets ↔ ทะเบียนสมาชิก (สองทาง จับคู่ด้วยรหัสสมาชิก) | เหมือนข้างบน |
| Google Calendar ↔ ปฏิทินชมรม (สองทาง, incremental sync, กำหนดการซ้ำอ่านอย่างเดียว) | เหมือนข้างบน |
| Google Forms: คำถาม ↔ เว็บ (เฉพาะชนิดพื้นฐาน), คำตอบ → เว็บ (อ่านอย่างเดียว), ตรวจแล้วเพิ่มเป็นสมาชิก | เหมือนข้างบน |
| Excel | อยู่นอกงานซิงค์ Google ยังไม่มีการทำงานส่วนนี้ หน้าเว็บแสดง “ยังไม่เปิดใช้” |

ข้อมูลจริงเริ่มจากว่าง ไม่มีการใส่ข้อมูลตัวอย่างหรือย้ายข้อมูลจากเบราว์เซอร์เข้า D1 อัตโนมัติ
ก่อนเชื่อมแหล่ง Google สมาชิกและกำหนดการอยู่ใน D1 (“ข้อมูลในเว็บ”) หลังเชื่อมแล้ว Google เป็นแหล่งหลักและ D1 เป็นสำเนาสำหรับแสดงผล รายการเดิมที่ยังไม่ได้ย้ายขึ้น Google มีป้าย “เฉพาะในเว็บ” กำกับ

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
| `npm run check:ui:member` | ตรวจบัญชีสมาชิกกับ Worker/D1 local, preview กับ Google จำลอง และ lifecycle ของ Picker กับ stub; ใช้พอร์ต/ฐานข้อมูลเดียวกับชุด live จึงต้องรันทีละชุด |
| `npm run types` | สร้าง type ของ Workers runtime ใหม่หลังแก้ `wrangler.jsonc` |

## โครงสร้างโครงการ

```
wrangler.jsonc            ค่าตั้ง Worker: local (บนสุด), env.staging, env.production
migrations/               โครงสร้าง D1 เรียงตามเลข (0001–0004 ระบบเดิม, 0005 student ID/บัญชีสมาชิก/session/throttle/คลังไฟล์) ใช้ซ้ำได้ทั้ง local และ remote
.dev.vars.example         ตัวอย่างค่าลับสำหรับเครื่อง (ไฟล์จริง .dev.vars ถูก gitignore)
.github/workflows/ci.yml  ตรวจ type, test, build, dry-run (ไม่ใช้ secret ไม่ deploy)

worker/                   โค้ดฝั่ง server (Cloudflare Worker, TypeScript, Web APIs)
  accounts.ts             ตั้ง/รีเซ็ต/ปิดบัญชีสมาชิก, login, ข้อมูลตนเอง, เปลี่ยนรหัส, กิจกรรม
  password.ts throttle.ts Argon2id และตัวนับจำกัดการลองรหัสผ่านใน D1
  library.ts              Drive list/preview ผ่านบัญชีชมรม (session สมาชิกหรือทีมงาน)
  index.ts                จัดเส้นทาง /api/* และ /auth/* ที่เหลือส่งให้ static assets
  auth.ts                 เข้าสู่ระบบ, callback, ออกจากระบบ, bootstrap ผู้ดูแล
  session.ts              session cookie, ตรวจสิทธิ์, CSRF, audit log
  google.ts               OAuth, ตรวจ id_token, token ของบัญชีชมรม (เข้ารหัส AES-GCM)
  members.ts events.ts    API สมาชิกและกำหนดการ (แก้ทีละรายการ + version + กันสร้างซ้ำ)
  users.ts                API จัดการบัญชีทีมงาน (เฉพาะผู้ดูแล)
  documents.ts            API เอกสาร: สร้าง/อ่าน/บันทึก/งานค้าง/ตรวจ revision/ผูกเอกสารเดิม/ซิงค์ชื่อ
  docs.ts                 ตัวแปลงข้อความ ↔ โครงสร้าง Google Docs (ฟังก์ชันล้วน)
  sync.ts                 แกนกลาง Google Sync: แหล่งที่เชื่อม สถานะต่อบริการ lease ช่วงขั้นต่ำ backoff งบคำขอ Cron
  sheets.ts               Google Sheets ↔ ทะเบียนสมาชิก
  gcal.ts                 Google Calendar ↔ ปฏิทินชมรม
  gforms.ts               Google Forms: โครงสร้าง คำตอบ การแก้คำถาม และการเพิ่มสมาชิกจากคำตอบ (/api/forms)
  setup.ts                /api/sync (สถานะและสั่งซิงค์) และ /api/setup (สร้าง/เลือก/ย้าย/ยกเลิกการเชื่อม เฉพาะผู้ดูแล)
  sources.ts              สถานะการเชื่อมบัญชี Google ของชมรม
  crypto.ts http.ts validation.ts env.ts

src/                      หน้าเว็บ (React)
  member/                 พอร์ทัลสมาชิกและหน้าเปลี่ยนรหัสชั่วคราว (ธีมสว่าง/มืด)
  tasks/                  งานที่มอบหมายและชุดส่งงานของสมาชิก/กลุ่ม
  library/                FileList/FilePreview/PdfViewer ใช้ร่วมกันทั้งสมาชิกและทีมงาน
  mode.ts                 โหมด live / demo
  api/client.ts           เรียก API พร้อม CSRF token และ key กันสร้างซ้ำ
  auth/                   AuthProvider, RequireAuth (รวมกรณีเซสชันหมดอายุ)
  data/                   repository (API และตัวอย่าง), store, ชนิดข้อมูล, sync (สถานะซิงค์และรอบตรวจอัตโนมัติ)
  lib/picker.ts           เปิด Google Picker ให้ผู้ดูแลเลือกไฟล์เดิม
  pages/                  ภาพรวม สมาชิก ปฏิทิน เอกสาร ฟอร์ม แหล่งข้อมูล (+ SourcesSetup) ทีมงาน เข้าสู่ระบบ
  components/             Layout, Dialog, Toast, ui, SyncBar (แถบสถานะแหล่งข้อมูล)

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
| `GOOGLE_PICKER_API_KEY` | ค่าตั้ง (ไม่ลับ แต่ต้องจำกัด) | `vars` ของ environment นั้นใน `wrangler.jsonc` (เครื่อง: `.dev.vars`) | API key ของเบราว์เซอร์สำหรับ Google Picker ว่าง = เลือกไฟล์เดิมจากเว็บไม่ได้ และหน้าเว็บบอกเหตุผล |
| `GOOGLE_CLOUD_PROJECT_NUMBER` | ค่าตั้ง (ไม่ลับ) | เหมือนข้างบน | เลขโครงการ Google Cloud ใช้เป็น App ID ของ Picker (production ใส่ไว้แล้ว = ส่วนหน้าของ client ID) |
| `triggers.crons` | ค่าตั้ง | `env.staging` / `env.production` ใน `wrangler.jsonc` (เครื่องไม่มี) | รอบ Cron ที่อัปเดตสำเนาจาก Google แม้ไม่มีคนเปิดเว็บ: production ทุก 5 นาที staging ทุก 15 นาที |
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
2. **เปิด API** ที่ APIs & Services → Library: `Google Drive API`, `Google Docs API` และสำหรับ Google Sync เพิ่ม `Google Sheets API`, `Google Calendar API`, `Google Forms API`, `Google Picker API`
3. **หน้าจอขอความยินยอม (OAuth consent screen / Google Auth Platform)**
   - Audience: **External** (บัญชี `@gmail.com` ใช้ Internal ไม่ได้)
   - ขณะสถานะเป็น **Testing** ให้เพิ่ม Test users: `muesport2567@gmail.com` **และบัญชี Google ของทีมงานทุกคนที่จะเข้าสู่ระบบ** (ในสถานะ Testing เฉพาะ test users เท่านั้นที่เข้าได้)
   - Scopes ที่ระบบขอจริง (เพิ่มรายการเหล่านี้ในหน้า Data Access ของ consent screen):

     | เมื่อไร | Scope | ใช้ทำอะไร |
     | --- | --- | --- |
     | เข้าสู่ระบบทีมงานด้วย Google | `openid`, `email`, `profile` | ยืนยันตัวตนเท่านั้น; สมาชิกใช้รหัสนักศึกษา ไม่ใช้ OAuth |
     | ผู้ดูแลเชื่อมบัญชีชมรม | `.../auth/drive.file` | Docs, Sheets และ Forms **เฉพาะไฟล์ที่เว็บสร้าง หรือที่ผู้ดูแลเลือกผ่าน Google Picker** ไม่เห็นไฟล์อื่นใน Drive |
     | ผู้ดูแลกด “ขอสิทธิ์เพื่อสร้างปฏิทินใหม่” | `.../auth/calendar.app.created` | สร้างปฏิทินรองและจัดการกำหนดการ เฉพาะปฏิทินที่เว็บสร้าง |
     | ผู้ดูแลกด “ขอสิทธิ์เพื่อเลือกปฏิทินที่มีอยู่” | `.../auth/calendar.calendarlist.readonly` + `.../auth/calendar.events` | อ่านรายชื่อปฏิทิน และอ่าน/แก้กำหนดการของปฏิทินที่บัญชีชมรมเข้าถึงได้ (กว้างกว่าทางแรก ขอเฉพาะเมื่อจะใช้ปฏิทินเดิม) |
     | ผู้ดูแลกด “เปิดใช้คลังไฟล์ Google” | `.../auth/drive.readonly` | อ่านรายการและเนื้อหาทั้งบัญชีชมรมสำหรับ preview รวมไฟล์เดิม/ไฟล์ที่แชร์ให้ชมรม; สมาชิกที่เปิดบัญชีแล้วอ่านได้ทั้งหมดตามขอบเขตที่เจ้าของระบบเลือก |

     สิทธิ์ Calendar และคลังไฟล์ขอแบบ incremental ผ่านขั้นตอนเชื่อมบัญชีเดิม (`include_granted_scopes=true`) ระบบเก็บ scopes ที่ Google ยืนยันว่าได้รับจริง ถ้าผู้ดูแลไม่ติ๊กให้ครบ บริการนั้นจะแสดงว่ายังใช้ไม่ได้ คลังไม่ต้องเลือกไฟล์ทีละไฟล์ ส่วนทะเบียน/ปฏิทิน/คำตอบ Forms ยังคงจับคู่กับแหล่งซิงค์ที่ตั้งไว้โดยเฉพาะ
     ถ้า Google ไม่ส่ง refresh token ใหม่ ระบบคง token เดิมของบัญชีเดียวกันไว้ ไม่ขอ Gmail, ทั้ง Drive (`drive`), `spreadsheets` หรือ `forms.*`
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

### Google Picker (เลือกไฟล์เดิมจากหน้าเว็บ)

ใช้เมื่อผู้ดูแลกด “เลือกชีต/ฟอร์มที่มีอยู่” หรือ “เชื่อมเอกสารที่มีอยู่” — สิทธิ์ `drive.file` เข้าถึงไฟล์เดิมได้เฉพาะเมื่อผู้ใช้เลือกไฟล์นั้นผ่าน Picker การวาง URL หรือรหัสไฟล์อย่างเดียวไม่ได้ให้สิทธิ์ (server ตรวจกับ Google ทุกครั้งและจะปฏิเสธ) จึงไม่มีช่องให้วางลิงก์

1. เปิด **Google Picker API** ในโครงการเดียวกับ OAuth client
2. Credentials → Create credentials → **API key** แล้วจำกัด: Application restrictions = *Websites* ใส่ `https://<โดเมนของเว็บ>/*` และ `https://docs.google.com/*` (เพิ่ม `http://localhost:5173/*` สำหรับ key ของเครื่อง) · API restrictions = *Google Picker API* เท่านั้น — Picker แสดงใน iframe ของ `docs.google.com` จึงต้องอนุญาตโดเมนนี้ด้วย ตาม [คู่มือ Google Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker)
3. ที่ OAuth client เดิม เพิ่มโดเมนของเว็บใน **Authorized JavaScript origins** (Picker ขอ token ในเบราว์เซอร์ด้วย Google Identity Services; ตารางด้านบนมี origin ที่ต้องใส่แล้ว)
4. ใส่ `GOOGLE_PICKER_API_KEY` และ `GOOGLE_CLOUD_PROJECT_NUMBER` (เลขโครงการ ดูที่หน้า Dashboard ของโครงการ หรือส่วนหน้าของ client ID) ใน `vars` ของ environment นั้น แล้ว build + deploy ใหม่
5. ตอนเลือกไฟล์ ต้องเลือกบัญชี **ชมรม** ในหน้าต่างของ Google ถ้าเลือกด้วยบัญชีอื่น server จะเปิดไฟล์ไม่ได้และแจ้งว่ายังไม่ได้รับสิทธิ์

access token ที่ Picker ใช้ในเบราว์เซอร์อยู่ในหน่วยความจำของหน้าเท่านั้น ไม่ถูกเก็บและไม่ส่งไป server ส่วน refresh token ของบัญชีชมรมอยู่ที่ Worker เท่านั้น ถ้ายังไม่ตั้งค่า Picker การ “สร้างชุดข้อมูลชมรม” ยังใช้ได้ตามปกติ

**ข้อจำกัดของสถานะ Testing:** Google ระบุว่า refresh token ของแอปแบบ External ที่ยังเป็น Testing และขอ scope นอกเหนือจากชื่อ อีเมล และโปรไฟล์ จะหมดอายุใน 7 วัน
ระบบนี้ขอ `drive.file` (และ Calendar เมื่อเปิดใช้) จึงเข้าข่าย: การเชื่อมบัญชีชมรมจะเข้าสถานะ “ต้องเชื่อมใหม่” ทุกประมาณ 7 วันจนกว่าจะเปลี่ยนสถานะเป็น **In production** — ระหว่างนั้น **การซิงค์ทุกบริการจะหยุด** หน้าเว็บแสดงข้อมูลที่อัปเดตสำเร็จล่าสุดพร้อมสถานะ “ซิงค์ไม่สำเร็จ / ข้อมูลอาจยังไม่ล่าสุด” จนกว่าผู้ดูแลจะกด “เชื่อมใหม่” จึงยังสัญญาไม่ได้ว่าซิงค์ต่อเนื่องถาวร
ก่อนใช้งานจริงต้องวางขั้นเผยแพร่แอปและทำตามเงื่อนไขการตรวจสอบ (verification) ที่ Google กำหนด ณ เวลานั้น — เอกสารนี้ไม่รับรองว่าการเชื่อมจะอยู่ได้ตลอด
อ้างอิง: <https://developers.google.com/identity/protocols/oauth2#expiration>

## Deploy ขึ้น Cloudflare

ผู้ดูแลโครงการทำเองทั้งหมด (โค้ดนี้ไม่ได้ login, สร้างทรัพยากร หรือ deploy ให้) แต่ละ environment คือ Worker คนละตัว ฐานข้อมูลคนละตัว และค่าลับคนละชุด:

| Environment | ชื่อ Worker | ฐานข้อมูล D1 | build ด้วย |
| --- | --- | --- | --- |
| เครื่อง | — | D1 local ใน `.wrangler/` | `npm run dev` |
| staging | `mu-esport-staff-staging` | `mu-esport-staff-staging` | `npm run build:staging` |
| production | `muesportbackend` | `mu-esport-backend-production` | `npm run build:production` |

URL production: `https://muesportbackend.muesport2567.workers.dev` และ Google OAuth callback: `https://muesportbackend.muesport2567.workers.dev/auth/google/callback`

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

หากเตรียมค่าลับทั้งสองไว้ใน `.dev.vars.production` บนเครื่องแล้ว สามารถนำขึ้น Worker พร้อมกันแทนคำสั่ง `secret put` ได้ด้วย `npx wrangler secret bulk .dev.vars.production --env production` ไฟล์นี้ต้องมีเฉพาะ `GOOGLE_CLIENT_SECRET` และ `TOKEN_ENCRYPTION_KEY` และไม่อยู่ใน Git อย่าเปลี่ยนกุญแจที่ใช้อยู่แล้ว เพราะ token เดิมจะถอดรหัสไม่ได้

6. เพิ่ม redirect URI ของโดเมนจริงใน Google Cloud (หัวข้อก่อนหน้า)
7. เปิดเว็บ → เข้าสู่ระบบด้วย `muesport2567@gmail.com` → หน้า “แหล่งข้อมูล” → “เชื่อมบัญชี Google ของชมรม” → หน้า “ทีมงาน” เพิ่มอีเมลทีมงาน

### ขั้นที่ 2 — deploy ครั้งต่อไป: Workers Builds เชื่อม GitHub (ทางหลัก)

ที่ Cloudflare dashboard → Workers & Pages → เลือก Worker → Settings → Builds → Connect repository แล้วตั้งค่า:

| ช่อง | Worker `muesportbackend` (production) | Worker `mu-esport-staff-staging` |
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

### ขั้นตอนเปิดใช้ Google Sync

โค้ดรุ่นนี้ต้องใช้ตารางจาก `migrations/0003_google_sync.sql` และ `migrations/0004_form_import_claims.sql` (เพิ่มตารางและคอลัมน์เท่านั้น ไม่ลบหรือแก้ข้อมูลเดิม) **ถ้า deploy โค้ดก่อนรัน migration หน้าเว็บจะโหลดกำหนดการและสถานะซิงค์ไม่ได้** และเพราะ Workers Builds deploy ทันทีเมื่อ push ขึ้น branch ที่ผูกไว้ ให้ทำตามลำดับนี้:

1. เครื่อง: `npm run db:migrate:local` แล้ว `npm run typecheck && npm test && npm run build && npm run check:dry-run`
2. (ถ้ามี staging) `npx wrangler d1 migrations apply DB --remote --env staging` → deploy staging → ทำ [Checklist ทดสอบกับ Google จริง](#checklist-ทดสอบกับ-google-จริง) บน staging
3. Google Cloud ของ production: เปิด Sheets / Calendar / Forms / Picker API, เพิ่ม scopes ของ Calendar ใน consent screen, สร้าง API key ของ Picker (หัวข้อ [Google Picker](#google-picker-เลือกไฟล์เดิมจากหน้าเว็บ)) แล้วใส่ `GOOGLE_PICKER_API_KEY` ใน `env.production.vars`
4. **รัน migration ของ production ก่อน**: `npx wrangler d1 migrations apply DB --remote --env production` (migration นี้เข้ากันได้กับโค้ดรุ่นเดิมที่รันอยู่ เพราะเพิ่มอย่างเดียว)
5. จากนั้นจึง push / deploy โค้ด (Cron ของ environment นั้นถูกสร้างพร้อม deploy จาก `triggers.crons`)
6. เข้าสู่ระบบด้วยบัญชีชมรม → หน้า “แหล่งข้อมูล” → (ถ้าจะใช้ปฏิทิน) กดขอสิทธิ์ Calendar → “สร้างชุดข้อมูลชมรม” หรือ “เลือก…ที่มีอยู่” → ตรวจ preview → ยืนยัน → (ถ้าต้องการ) “ย้าย…ในเว็บขึ้น Google”

ไม่มีขั้นใดสร้างหรือแก้ข้อมูลใน Google จาก CLI ทรัพยากรใน Google ถูกสร้างเฉพาะเมื่อผู้ดูแลกดยืนยันในหน้าเว็บ และค่าลับ/กุญแจเข้ารหัส/callback เดิมของ production ไม่ต้องเปลี่ยน

### เปลี่ยนโครงสร้างฐานข้อมูลภายหลัง

เพิ่มไฟล์ใหม่ใน `migrations/` (เช่น `0002_xxx.sql`) เท่านั้น ไม่แก้ไฟล์เดิม ไม่มีคำสั่งรีเซ็ตฐานข้อมูลจริงในโครงการนี้
ลำดับ: ใช้กับเครื่อง (`npm run db:migrate:local`) → staging (`--remote --env staging`) → ตรวจ → production (`--remote --env production`)

## Checklist ก่อน push และก่อน deploy

**ก่อน push ขึ้น GitHub ครั้งแรก**

- [ ] ตรวจ `git status` ว่า **ไม่มี** `.dev.vars*`, `.env*`, `.wrangler/`, ไฟล์ `client_secret*.json` หรือ token ใด ๆ (ทั้งหมดอยู่ใน `.gitignore` แล้ว)
- [ ] `wrangler.jsonc` ไม่มีค่าลับ (มีได้แค่ `GOOGLE_CLIENT_ID`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER` และ `database_id` ซึ่งไม่ใช่ค่าลับ)
- [ ] **push ขึ้น branch ที่ผูกกับ Workers Builds = deploy** ต้องรัน migration ของ environment นั้นก่อน (ดู [ขั้นตอนเปิดใช้ Google Sync](#ขั้นตอนเปิดใช้-google-sync))
- [ ] ไม่แชร์หรือ commit โฟลเดอร์ `dist/` (ถูก gitignore): ตอน build Cloudflare Vite plugin คัดลอก `.dev.vars` ของ environment นั้นไว้ที่ `dist/mu_esport_staff/.dev.vars` สำหรับ `vite preview` ไฟล์นี้ไม่อยู่ใน `dist/client` จึงไม่ถูกส่งให้เบราว์เซอร์ แต่มีค่าลับจริง
- [ ] โฟลเดอร์ `screenshots/` มีเฉพาะภาพจากข้อมูลทดสอบ (ภาพจากข้อมูลจริงให้เก็บใน `screenshots-private/` ซึ่งถูก ignore)
- [ ] `npm run typecheck`, `npm test`, `npm run build`, `npm run check:dry-run` ผ่าน
- [ ] ตั้ง repository เป็น private ถ้าไม่ต้องการเปิดเผยโครงสร้างระบบ

**ก่อน deploy production ครั้งแรก**

- [ ] สร้าง D1 และใส่ `database_id` จริงใน `env.production` (ไม่มี `REPLACE_WITH_` เหลือ)
- [ ] ใส่ `GOOGLE_CLIENT_ID` ของ production ใน `env.production.vars`
- [ ] รัน migrations แบบ `--remote --env production` **ก่อน** deploy โค้ดที่ต้องใช้ (ตอนนี้มี 4 ไฟล์: `0001`–`0004` คำสั่งเดียวใช้ทุกไฟล์ที่ยังไม่เคยใช้)
- [ ] ตั้ง Worker Secrets ครบสองตัว: `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (กุญแจใหม่ ไม่ใช้ค่าเดียวกับเครื่อง)
- [ ] Google Cloud: เปิด Drive + Docs + Sheets + Calendar + Forms + Picker API, redirect URI และ JavaScript origin ของโดเมนจริงตรงตัวอักษร, เพิ่ม scopes ของ Calendar ใน consent screen, เพิ่ม test users (ถ้ายังเป็น Testing)
- [ ] ใส่ `GOOGLE_PICKER_API_KEY` (จำกัด referrer และจำกัดเฉพาะ Picker API) ถ้าจะเลือกไฟล์เดิม
- [ ] build ด้วย `npm run build:production` (ไม่ใช่ `npm run build`)

**หลัง deploy (ตรวจด้วยมือ เพราะยังไม่เคยตรวจกับ Google จริง)**

- [ ] เปิด `https://<โดเมน>/api/session` ได้ JSON ที่ `authConfigured: true`
- [ ] เข้าสู่ระบบด้วยบัญชีชมรมได้ และบัญชีที่ไม่ได้เพิ่มสิทธิ์เห็นหน้า “ไม่มีสิทธิ์เข้าใช้งาน”
- [ ] หน้า “แหล่งข้อมูล”: เชื่อมบัญชีชมรม → สถานะ “เชื่อมแล้ว” และลองเชื่อมด้วยบัญชีอื่นแล้วถูกปฏิเสธ
- [ ] หน้า “เอกสาร”: สร้าง **เอกสารทดสอบใหม่** (ไม่ใช้ไฟล์เดิมของชมรม) ใส่ภาษาไทย ขึ้นบรรทัดใหม่ และ emoji → เปิดใน Google Docs ตรวจว่าตรงกัน → แก้ใน Google Docs → กลับมาบันทึกจากเว็บแล้วเห็นข้อความ conflict
- [ ] เปิดจากมือถือและคอมพิวเตอร์ด้วยคนละบัญชี เพิ่มสมาชิกจากเครื่องหนึ่งแล้ว refresh อีกเครื่องเห็นข้อมูลเดียวกัน

### Checklist ทดสอบกับ Google จริง

ยังไม่มีข้อใดถูกทำในรุ่นนี้ ให้ทำกับ**ทรัพยากรทดสอบ**ที่สร้างหรือเลือกผ่านหน้า “แหล่งข้อมูล” ก่อนใช้กับข้อมูลจริงของชมรม และจดผลแยกจากผลของชุดทดสอบอัตโนมัติ (ซึ่งใช้ Google จำลอง) วัดความหน่วงด้วยนาฬิกา: เวลาตั้งแต่บันทึกฝั่งหนึ่งจนอีกฝั่งแสดง

- [ ] **ตั้งค่า**: “สร้างชุดข้อมูลชมรม” สร้างชีต ปฏิทิน ฟอร์มใหม่ได้ มีอย่างละหนึ่งรายการในบัญชีชมรม ลิงก์ “เปิดต้นฉบับ” เปิดถูกไฟล์ และกดสร้างซ้ำไม่เกิดรายการที่สอง
- [ ] **Picker**: “เลือกชีต/ฟอร์มที่มีอยู่” และ “เชื่อมเอกสารที่มีอยู่” เปิดหน้าต่างของ Google ได้ เลือกด้วยบัญชีชมรมแล้วเชื่อมได้ เลือกด้วยบัญชีอื่นถูกปฏิเสธพร้อมเหตุผล
- [ ] **Sheets → เว็บ**: แก้ชื่อเล่นในชีต / เพิ่มแถวใหม่โดยไม่ใส่รหัส / เรียงแถวใหม่ → หน้าสมาชิกและตัวเลขหน้าภาพรวมตามภายในรอบตรวจ (จดเวลาที่ใช้) รหัสถูกเติมเฉพาะเซลล์รหัส
- [ ] **เว็บ → Sheets**: เพิ่ม/แก้/พัก/คืนสถานะสมาชิกในเว็บ → เซลล์ที่เกี่ยวข้องในชีตเปลี่ยน คอลัมน์อื่นและสูตรไม่ถูกแตะ เบอร์โทรที่ขึ้นต้นด้วย 0 ยังครบ
- [ ] **Sheets conflict**: เปิดฟอร์มแก้ในเว็บค้างไว้ แก้แถวเดียวกันในชีต แล้วบันทึกจากเว็บ → ได้ข้อความ conflict พร้อมค่าล่าสุด ชีตไม่ถูกทับ
- [ ] **Calendar → เว็บ**: เพิ่ม/แก้เวลา/ลบกำหนดการ กำหนดการทั้งวันและหลายวัน และกำหนดการซ้ำ (รวมแก้/ยกเลิกครั้งเดียว) ใน Google Calendar → หน้าปฏิทินและภาพรวมตรงกัน เวลาเป็นเวลาไทย
- [ ] **เว็บ → Calendar**: เพิ่ม/แก้กำหนดการในเว็บ → ปรากฏใน Google Calendar ครั้งเดียว ไม่มีอีเมลเชิญ แขกและสีเดิมของรายการที่แก้ยังอยู่ กำหนดการซ้ำแก้จากเว็บไม่ได้และมีปุ่มเปิด Google Calendar
- [ ] **Forms**: ส่งคำตอบจริงผ่านหน้าฟอร์ม / แก้คำถามใน Google Forms → หน้า “ฟอร์ม” ตาม · แก้หัวเรื่องและคำถามพื้นฐานจากเว็บ → Google Forms เปลี่ยน · คำถามแบบตาราง/อัปโหลดไฟล์/branching เป็นอ่านอย่างเดียว · “ตรวจและเพิ่มเป็นสมาชิก” เพิ่มลงทะเบียน (และลงชีตถ้าเชื่อมไว้) ครั้งเดียว
- [ ] **Docs**: เปลี่ยนชื่อและแก้ข้อความใน Google Docs ขณะเปิดเอกสารเดียวกันในเว็บ → ไม่มีร่าง: เว็บโหลดฉบับใหม่เอง · มีร่าง: ขึ้น “มีฉบับใหม่ใน Google Docs” ร่างไม่หาย และเลือก เปรียบเทียบ/เก็บร่าง/โหลดฉบับล่าสุด ได้
- [ ] **ความล้มเหลว**: ถอนสิทธิ์แอปที่ <https://myaccount.google.com/permissions> → ทุกหน้าแสดงข้อมูลเดิมพร้อม “ซิงค์ไม่สำเร็จ” ไม่กลายเป็นรายการว่าง → “เชื่อมใหม่” แล้วกลับมาซิงค์ได้และสิทธิ์ Docs เดิมยังใช้ได้
- [ ] **หลายอุปกรณ์**: เปิดมือถือกับคอมพิวเตอร์พร้อมกัน แก้ฝั่งหนึ่ง อีกฝั่งตามภายในรอบตรวจโดยไม่ต้อง refresh
- [ ] **Cron**: ปิดทุกแท็บ แก้ข้อมูลใน Google รอเกินรอบ Cron แล้วเปิดเว็บ → เวลา “อัปเดตล่าสุด” เป็นเวลาที่ Cron ทำ (ดู log ของ Worker ประกอบ)
- [ ] **ยกเลิกการเชื่อม**: ข้อมูลในเว็บและต้นฉบับใน Google อยู่ครบทั้งสองฝั่ง

## การทดสอบ

| ชุด | คำสั่ง | ใช้อะไร | ครอบคลุม |
| --- | --- | --- | --- |
| Worker | `npm test` | Workers runtime (workerd) + D1 local ที่ใช้ migrations จริง + **Google จำลอง** (แทน `fetch` เฉพาะใน test) | สิทธิ์ทุกเส้นทาง, staff/admin, bootstrap ผู้ดูแล, คำขอสร้างเอกสารพร้อมกัน/lease หมด/ผลไม่แน่ชัด/นำงานออกขณะทำ (`test/document-races.test.ts`), session หมดอายุ/ออกจากระบบ/ถอนสิทธิ์, CSRF, validation, สอง session ใช้ฐานเดียวกัน, 409 เมื่อแก้จากข้อมูลเก่า, สร้างซ้ำไม่เกิดรายการซ้ำ, OAuth state/nonce/PKCE/บัญชีผิด/refresh token/invalid_grant, ค่าลับไม่หลุด, ตัวแปลง Google Docs (ไทย/ขึ้นบรรทัด/emoji/เอกสารว่าง/โครงสร้าง rich), revision conflict, สร้างเอกสารสำเร็จบางส่วนแล้วทำต่อ |
| Worker: Google Sync | `npm test` (`test/sync-*.test.ts`) | เหมือนข้างบน + **Sheets/Calendar/Forms/Drive จำลอง** (`test/workspace.ts`) | Google แก้ → เว็บ และ เว็บแก้ → Google ทุกบริการ, สร้างชุดข้อมูล/คำตอบหาย/retry ไม่สร้างซ้ำ, เรียงแถวใหม่ไม่จับคู่ผิด, แถวไม่มีรหัส/รหัสซ้ำ/แถวผิดรูปแบบ/แถวหาย/คอลัมน์หาย, ไม่เขียนทับสูตร, race ของ Sheets ที่เหลือ, แบ่งหน้า, sync token หมดอายุ (410), เวลา/ทั้งวัน/หลายวัน, กำหนดการซ้ำและข้อยกเว้น, etag conflict, ผลไม่แน่ชัด, สิทธิ์อ่านอย่างเดียว, scope ไม่ครบ/token ถูกถอน, rate limit + backoff, รวมคำขอที่ซ้ำ, Cron, บริการหนึ่งล้มเหลวไม่กระทบบริการอื่น, คำถามถูกลบ/แทนที่, คำตอบอ่านอย่างเดียว, คำตอบ → สมาชิกไม่ยกระดับสิทธิ์, ยกเลิกการเชื่อม |
| UI โหมดจริง | `npm run check:ui:live` | Edge (Chromium) + WebKit ของ Playwright, `vite dev` + Worker + D1 local ทดสอบ | เข้าสู่ระบบ/ปฏิเสธสิทธิ์, ข้อมูลร่วมสอง session, conflict, retry ไม่ซ้ำ, เซสชันหมดอายุระหว่างแก้เอกสาร, ทีมงาน, แหล่งข้อมูล, หน้าเอกสารทุกสถานะ, 1440/1024/768/390/320 และแนวนอน, คีย์บอร์ด/focus/เมนู — ข้อที่ขึ้นต้นด้วย `[จำลอง]` ตอบ API ของระบบด้วยข้อมูลจำลองในเบราว์เซอร์เพื่อดูหน้าจอ · Google Sync: แถบสถานะแหล่งข้อมูล (ที่มา/อัปเดตล่าสุด/กำลังซิงค์/ไม่สำเร็จ/อาจไม่ล่าสุด/รายการที่ต้องแก้/อ่านอย่างเดียว), ร่างและ focus ไม่ถูกทับเมื่อข้อมูลจาก Google เปลี่ยน, หลายแท็บสั่งซิงค์ครั้งเดียว, กำหนดการซ้ำ, หน้า “ฟอร์ม” (คำตอบอ่านอย่างเดียว conflict เพิ่มสมาชิกจากคำตอบ), ตั้งค่าพื้นที่ข้อมูล (สร้างชุด/retry ด้วย key เดิม/preview/ยกเลิกการเชื่อม), “มีฉบับใหม่ใน Google Docs” ทั้ง admin/staff จอกว้าง/มือถือ ธีมสว่าง/มืด — ข้อ `[จำลอง Picker]` แทนสคริปต์ของ Google ด้วยตัวจำลอง **ไม่ได้เปิด Google Picker จริง** |
| UI โหมดตัวอย่าง | `npm run check:ui` | Edge (Chromium), `npm run dev:demo` | regression ของหน้าจอเดิมทั้งหมด |

- ผู้ใช้และ session สำหรับทดสอบถูกสร้างตรงในฐานข้อมูลทดสอบ (`test/helpers.ts`, `scripts/local-fixtures.mjs`) Worker **ไม่มี** เส้นทางข้ามการเข้าสู่ระบบ, token เริ่มต้น, endpoint ใส่ข้อมูลตัวอย่าง/รีเซ็ต หรือ Google จำลองในเส้นทางจริง (มี test ยืนยันว่าเส้นทางเหล่านี้ตอบ 404)
- ชุด UI ต้องมี Microsoft Edge (หรือตั้ง `BROWSER_CHANNEL=chrome`) และ WebKit ติดตั้งด้วย `npx playwright-core install webkit` ถ้าไม่มี WebKit ชุดตรวจจะข้ามส่วนนั้นและบอกไว้
- ชุด UI โหมดจริงรันกับ dev server ซึ่งเปิด React StrictMode: effect ตอนเปิดหน้าถูกเรียกซ้ำ จึงมีคำขออ่านข้อมูลสองชุดต่อการเปิดหน้า (production build ส่งชุดเดียว)
  หน้าเว็บคงสถานะ “กำลังโหลด” ไว้จนกว่าการโหลดครั้งล่าสุดจะเสร็จ (`reload` ใน `src/data/store.tsx`) ชุดตรวจจึงใช้การหายไปของสถานะนี้เป็นสัญญาณว่าข้อมูลถูกวาดแล้วได้ และมีข้อตรวจยืนยันสัญญาณนี้โดยกั้นคำตอบของคำขอตัวล่าสุดไว้ (`probeLoadSignal`)
  ข้อตรวจ “ปฏิทินเดือน: เห็นเวลาและชื่อกำหนดการในช่องวัน” เลือกกำหนดการจาก id ของข้อมูลทดสอบ รอให้ป้ายของรายการนั้นแสดง แล้วจึงตรวจว่าเวลาและชื่อตรงกับข้อมูล มองเห็นได้จริง และอยู่ในกรอบของช่องวัน ถ้าไม่ผ่านจะเก็บภาพหน้าจอและไฟล์ `screenshots/diag-month-chip-*.json` (รายการที่แสดง ข้อมูลจาก API และลำดับคำขอ ไม่มี cookie หรือ token) ตัวตรวจทั้งสองอยู่ใน `scripts/ui-data-ready.mjs`

## หลักการออกแบบที่ควรรู้

**ข้อมูลร่วมกัน**

- ทุกคำสั่งแก้ทีละรายการ (`PATCH /api/members/:id`) ไม่มีการเขียนข้อมูลทั้งชุด
- สมาชิก/กำหนดการมี `version` การแก้ต้องส่ง `expectedVersion` และ server ใช้ `UPDATE ... WHERE id = ? AND version = ?` คนที่แก้จากข้อมูลเก่าได้ `409` พร้อมค่าล่าสุด หน้าเว็บเก็บค่าที่กรอกไว้และมีปุ่ม “โหลดค่าล่าสุด”
- การสร้างส่ง header `Idempotency-Key` (ผูกกับผู้ใช้ + ชนิดคำสั่ง + ข้อมูล) ลองใหม่ด้วย key เดิมได้รายการเดิม
- หน้าเว็บแสดงว่าสำเร็จหลัง server ยืนยันเท่านั้น และดึงข้อมูลใหม่เมื่อบันทึก กลับเข้าแท็บ หรือเมื่อรอบซิงค์พบว่าสำเนาเปลี่ยน อุปกรณ์อื่นเห็นผลภายในรอบตรวจ (ประมาณ 60 วินาทีขณะหน้าเปิดอยู่) — **ไม่ใช่ real time**

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
- API editor เดิมจัดการเฉพาะเอกสารที่สร้างผ่านเว็บหรือที่ผู้ดูแลเลือกผ่าน Google Picker (`drive.file`) ส่วนหน้าไฟล์ชมรมอ่านไฟล์ทั้งบัญชีผ่านคลังแยก (`drive.readonly`) ไม่เพิ่มไฟล์เหล่านั้นเข้าระบบ sync/editor โดยอัตโนมัติ
- editor รองรับข้อความพื้นฐาน: ย่อหน้า ขึ้นบรรทัดใหม่ จำกัด 50,000 หน่วย UTF-16
- **ชื่อเอกสารตั้งได้ตอนสร้างเท่านั้น** หลังสร้างแล้วช่องชื่อในเว็บเป็นอ่านอย่างเดียว และ server ปฏิเสธคำขอเปลี่ยนชื่อ (`title_change_not_supported`)
  เหตุผล: การเปลี่ยนชื่อเป็นคำสั่งของ Drive ซึ่งไม่มีเงื่อนไข revision ให้ Google ตรวจ (`requiredRevisionId` ใช้ได้กับ Docs `batchUpdate` เท่านั้น) จึงกันการเขียนทับชื่อที่คนอื่นเพิ่งเปลี่ยนไม่ได้
  เปลี่ยนชื่อใน Google Docs ได้ตามปกติ รายการในเว็บจะตามชื่อจริงเมื่อเปิดหรือบันทึกเอกสารนั้น
- เอกสารที่มีตาราง รูป หลายแท็บ หัว/ท้ายกระดาษ เชิงอรรถ รายการ หัวข้อ การจัดรูปแบบตัวอักษร หรือคำแนะนำค้าง จะเปิดอ่านอย่างเดียวพร้อมเหตุผล และไม่ถูกเขียนทับ
- บันทึกแก้เฉพาะช่วงที่ต่าง ด้วย `writeControl.requiredRevisionId` ถ้าเอกสารถูกแก้จากที่อื่น Google จะปฏิเสธและหน้าเว็บให้ตรวจฉบับล่าสุดโดยเก็บสิ่งที่พิมพ์ไว้
- ระหว่างเปิดหน้าแก้เอกสาร เว็บตรวจ `revisionId` ของ Google ประมาณทุก 60 วินาที (ไม่ดึงเนื้อหา): ไม่มีร่างค้าง → โหลดฉบับใหม่ให้เอง · มีร่างค้าง → ไม่ทับร่าง แสดง “มีฉบับใหม่ใน Google Docs” ให้ เปรียบเทียบ / เก็บร่างไว้ก่อน / โหลดฉบับล่าสุด
- รายการเอกสารตามชื่อใน Google ผ่านรอบซิงค์ (ตรวจ metadata ทีละ 12 ไฟล์ เริ่มจากไฟล์ที่ไม่ได้ตรวจนานที่สุด) ผู้ดูแลผูกเอกสารเดิมได้ผ่าน Google Picker
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

**Google Sync (ทุกบริการใช้แกนเดียวกันใน `worker/sync.ts`)**

- **แหล่งหลักและสำเนา**: Google เป็นแหล่งหลักของข้อมูลที่เชื่อมแล้ว D1 เก็บสำเนา (`members`/`events` ที่ `source` เป็น `sheets`/`calendar`, `form_items`, `form_responses`) สถานะซิงค์ (`sync_state`) และข้อมูลของแอป (sessions, สิทธิ์ทีมงาน) รายการที่ยังไม่ได้ย้ายขึ้น Google มี `source = 'local'` และป้าย “เฉพาะในเว็บ”
- **รอบตรวจ**: หน้าเว็บสั่งซิงค์เมื่อเปิดหน้า เมื่อกลับเข้าแท็บ และประมาณทุก 60 วินาทีขณะหน้ามองเห็นอยู่ server รวมคำขอของทุกแท็บและทุกอุปกรณ์: ต่อบริการทำงานได้ทีละหนึ่งคำขอ (lease ใน D1) และไม่ถี่กว่า 45 วินาที แท็บในเบราว์เซอร์เดียวกันยังแบ่งกันด้วย localStorage
  เมื่อสำเนาเปลี่ยน `data_version` จะเพิ่ม ทุกแท็บโหลดรายการใหม่เงียบ ๆ โดยไม่แตะฟอร์มที่กำลังกรอก **60 วินาทีเป็นเป้าหมายภายใต้การเชื่อมปกติ ไม่ใช่การรับประกัน** — Google อาจช้าหรือจำกัดคำขอ
- **Cron** (`scheduled` ใน `worker/index.ts`): อัปเดตสำเนาแม้ไม่มีคนเปิดเว็บ ใช้ lease เดียวกับคำขอจากหน้าเว็บ และตั้งแยกต่อ environment ไม่ได้ใช้ webhook/Pub/Sub
  งบคำขอรวม 40 ต่อรอบ แบ่งให้ทุกบริการ: แต่ละบริการได้ งบที่เหลือ ÷ จำนวนบริการที่ยังไม่ได้ทำ (อย่างน้อย 10 เสมอ) หักตามที่ใช้จริง และลำดับเริ่มต้นหมุนตามช่วงเวลา บริการที่ใช้งบเต็ม แบ่งหน้ายาว หรือล้มเหลว จึงไม่ทำให้ Docs หรือบริการลำดับท้ายถูกข้าม (`runScheduled` ใน `worker/sync.ts`)
- **ล้มเหลว**: เก็บสำเนาสำเร็จครั้งก่อนไว้เสมอ ไม่แทนด้วยรายการว่าง บันทึกรหัสและข้อความไทยต่อบริการ เว้นระยะแบบ exponential (1 นาที → สูงสุด 30 นาที เคารพ `Retry-After`) ปุ่ม “อัปเดตจาก Google” ข้ามช่วงขั้นต่ำได้แต่ไม่ข้าม rate limit ของ Google บริการหนึ่งล้มเหลวไม่กระทบบริการอื่น
- **เขียนจากเว็บ**: เขียนไปที่ Google ก่อน แล้วปรับสำเนาจากสิ่งที่ Google ยืนยัน (อ่านกลับหรือคำตอบของคำสั่ง) ถ้า Google ตอบ 5xx/คำตอบหาย รายงาน `save_outcome_unknown` แยกจาก “ไม่สำเร็จ”
  การเขียนใช้ตัวตนของ Google (รหัสสมาชิก, event ID, item ID) และ event ID/รหัสที่กำหนดล่วงหน้าจาก key ของคำขอ การลองใหม่จึงไม่สร้างรายการซ้ำ และรอบซิงค์ถัดไปเห็นเป็นรายการเดิม (etag/hash เดิม) จึงไม่วนส่งกลับไปกลับมา
- **ยกเลิกการเชื่อม / เปลี่ยนแหล่ง**: ไม่ลบต้นฉบับใน Google และไม่ลบสำเนาในเว็บ สำเนากลับเป็นข้อมูลของเว็บ เปลี่ยนแหล่ง = ยกเลิกแล้วเชื่อมใหม่

**Sheets ↔ ทะเบียนสมาชิก** (`worker/sheets.ts`)

- จับคู่แถวด้วย**รหัสสมาชิก**ในคอลัมน์ที่กำหนด ไม่ใช้ลำดับแถว และจับคู่คอลัมน์ด้วย**ข้อความหัวคอลัมน์** ไม่ใช้เลขคอลัมน์ อ่านและเขียนด้วย `sheetId` จึงเปลี่ยนชื่อแท็บ ย้ายคอลัมน์ เรียง แทรก ลบแถวได้
- แถวใหม่ที่พิมพ์ในชีตโดยไม่มีรหัส: ระบบออกรหัสและเขียนเฉพาะเซลล์รหัส (และวันที่เพิ่มถ้าเว้นว่าง) · รหัสซ้ำ/แถวผิดรูปแบบ/คอลัมน์หาย: แสดงเป็นรายการที่ต้องแก้ ไม่เดา ไม่ทิ้งเงียบ ๆ · แถวที่หาย: สมาชิกถูกทำเครื่องหมาย “ไม่พบในชีตต้นฉบับ” ไม่ลบ และมีบันทึกใน `audit_log`
- บทบาทในชีตเป็นข้อมูลของสมาชิกเท่านั้น ไม่มีเส้นทางใดจาก Sheets/Forms ไปตาราง `users`
- เว็บเขียนเฉพาะเซลล์ที่เปลี่ยนในคอลัมน์ที่จับคู่ไว้ด้วยค่าแบบ RAW ไม่ล้างชีต ไม่แตะคอลัมน์อื่น และปฏิเสธการเขียนทับเซลล์ที่เป็นสูตร
- **Sheets API ไม่มี compare-and-swap ระดับแถว** ระบบจึง: (1) อ่านชีตทันทีก่อนเขียนและเทียบกับรุ่นที่ผู้ใช้เปิด → ต่างกันได้ `version_conflict` (2) อ่านแถวนั้นซ้ำแบบสูตรเพื่อยืนยันว่าแถวยังเป็นของรหัสเดิม (3) อ่านกลับหลังเขียนเพื่อยืนยัน และตรวจกรณีค่าลงผิดแถว (`write_misplaced` แจ้งเลขแถวที่กระทบ)
  **race ที่เหลือ**: ถ้ามีคนเรียง/แทรก/ลบแถวในชีตในช่วงสั้นมาก (ระดับเสี้ยววินาที) ระหว่างขั้น 2 กับคำสั่งเขียนไปถึง Google ค่าอาจลงผิดแถว ระบบตรวจพบหลังเกิดและแจ้ง แต่กันไม่ได้ ต้องแก้ด้วยประวัติเวอร์ชันของ Google Sheets การเขียนพร้อมกันจากผู้ใช้เว็บด้วยกันถูกกันด้วย lock ใน D1 (`write_locks`)

**Calendar ↔ ปฏิทินชมรม** (`worker/gcal.ts`)

- จับคู่ด้วย calendar ID + event ID ใช้ incremental sync (`syncToken`) ตามเอกสารของ Google พร้อมแบ่งหน้า รอบดึงทั้งชุดเริ่มจากย้อนหลัง 400 วัน token ใช้ไม่ได้ (410) → ดึงใหม่ทั้งชุดเฉพาะปฏิทินนี้ในรอบถัดไป ข้อมูลอื่นไม่ถูกล้าง
- เวลาเก็บเป็นเวลาท้องถิ่น Asia/Bangkok (UTC+7 ไม่มี DST): แปลงจาก offset ใด ๆ ได้ ทั้งวันของ Google ใช้วันสิ้นสุดแบบไม่รวม ระบบแปลงไปกลับให้ วินาทีถูกตัด
- **กำหนดการซ้ำ**: เก็บตัวตนของ series (`calendar_series`) แล้วให้ Google กระจายรายการย่อยรวมข้อยกเว้น ในช่วงย้อนหลัง 180 วันถึงข้างหน้า 400 วัน (กระจายใหม่เมื่อ series เปลี่ยนหรือทุก 12 ชั่วโมง) เว็บแสดงรายการย่อยแต่**ไม่แก้ทั้งรายการย่อยและทั้งชุด** มีปุ่มเปิด Google Calendar แทน รายการชนิดพิเศษและรายการที่ปฏิทินนี้ไม่ใช่ผู้จัดก็อ่านอย่างเดียว
- เว็บแก้ด้วย `PATCH` เฉพาะฟิลด์ที่เปลี่ยน (ชื่อ เวลา สถานที่ รายละเอียด) พร้อม `If-Match` (etag) และ `sendUpdates=none`: ไม่ทับการแก้ของคนอื่น ไม่แตะแขก/ACL/ฟิลด์อื่น และไม่ส่งอีเมลเชิญ
- ปฏิทินที่บัญชีชมรมอ่านได้อย่างเดียว: หน้าเว็บแสดง “อ่านอย่างเดียว” และ server ปฏิเสธการเพิ่ม/แก้โดยไม่เรียกคำสั่งเขียนของ Google
- รายการที่ถูกยกเลิก/ลบใน Google ไม่แสดงในเว็บ แต่แถวใน D1 ไม่ถูกลบ (`source_state = 'cancelled'`)

**Forms** (`worker/gforms.ts`)

- แยกสามส่วน: โครงสร้างฟอร์ม (`form_items`) คำตอบต้นฉบับ (`form_responses`) และสมาชิกที่เพิ่มจากคำตอบ (`members`) จับคู่ด้วย formId, itemId/questionId, responseId
- คำถามที่ถูกลบจากฟอร์มเก็บไว้พร้อมเวลาที่หาย คำตอบเก่าจึงยังอ่านได้ และไม่กลายเป็นคำตอบของคำถามใหม่ที่ใช้ชื่อเดิม
- เว็บแก้ได้: หัวเรื่อง คำอธิบาย และคำถามแบบคำตอบสั้น/ย่อหน้า/เลือกข้อเดียว/เลือกหลายข้อ/เลื่อนลง (ข้อความ บังคับตอบ ตัวเลือก) และเพิ่มคำถามชนิดเหล่านี้ต่อท้าย ด้วย `forms.batchUpdate` + `requiredRevisionId` + `updateMask`
  อ่านอย่างเดียวพร้อมลิงก์เปิด Google Forms: ตาราง อัปโหลดไฟล์ สเกล วันที่ เวลา การให้คะแนน ส่วนของฟอร์ม รูป/วิดีโอ ตัวเลือกที่มี branching หรือรูป คำถามที่มีคะแนน และฟอร์มแบบ quiz รวมถึงการลบและจัดลำดับ
- **คำตอบอ่านอย่างเดียว**: Forms API มีเฉพาะ get/list ของคำตอบ จึงไม่มีปุ่มหรือเส้นทางแก้/ส่งคำตอบจากเว็บ การส่งคำตอบทำผ่านหน้าฟอร์มของ Google เท่านั้น ฟอร์มที่เว็บสร้างยังไม่ถูกเผยแพร่จนกว่าผู้ดูแลจะเปิดเองใน Google Forms
- คำตอบดึงผ่าน Forms API อย่างเดียว (ไม่ใช้ชีตคำตอบของฟอร์ม จึงไม่มีการนำเข้าซ้ำสองทาง) รอบปกติขอเฉพาะคำตอบที่ส่ง/แก้หลังครั้งก่อน และตรวจทั้งชุดทุก 6 ชั่วโมงเพื่อรู้ว่าคำตอบใดถูกลบที่ Google (ทำเครื่องหมาย ไม่ลบสำเนา)
- “ตรวจและเพิ่มเป็นสมาชิก”: ผู้ดูแลจับคู่คำถามกับชื่อ/ชื่อเล่น/ติดต่อ/หมายเหตุ หน้าตรวจแสดงค่าที่เสนอ การตรวจข้อมูล และรายการที่อาจซ้ำ สมาชิกที่เพิ่มมีบทบาท “สมาชิก” เสมอ ลงชีตที่เชื่อม (หรือ D1 ถ้ายังไม่เชื่อม) และไม่แตะสิทธิ์เข้าหลังบ้าน
  หนึ่งคำตอบนำเข้าได้ครั้งเดียวไม่ว่าทีมงานกี่คนกดพร้อมกัน: คำขอแรกจอง `(form_id, response_id)` ในตาราง `form_imports` (PRIMARY KEY) พร้อมรหัสสมาชิกและค่าที่ยืนยัน ทุกคำขอจากทุกบัญชีใช้รหัสและค่าชุดนั้น ถ้างานค้างกลางทาง (เช่น Google ต่อแถวแล้วแต่คำตอบหาย) คำขอถัดไปทำต่อรายการเดิม คนที่ส่งค่าต่างออกไปได้ `already_imported` ผู้กระทำถูกบันทึกแยก (`claimed_by`, `completed_by`, `audit_log`) การแก้ข้อมูลสมาชิกภายหลังซิงค์กับ Sheets ไม่ใช่กับคำตอบใน Forms

**ตั้งค่าพื้นที่ข้อมูล** (`worker/setup.ts`)

- ทรัพยากรใน Google ถูกสร้างเฉพาะเมื่อผู้ดูแลกดยืนยันใน “สร้างชุดข้อมูลชมรม” ไม่สร้างตอนเปิดหน้า เข้าสู่ระบบ หรือเชื่อมบัญชี
- กันสร้างซ้ำเหมือนงานสร้างเอกสาร (ตาราง `setup_operations`): key ของคำขอ + lease + เครื่องหมายก่อนสร้าง ถ้าคำตอบของ Google หาย = “ไม่ทราบผล” ระบบค้นหาของเดิมก่อน (ชีต: ป้าย `appProperties` · ปฏิทิน: เครื่องหมายในคำอธิบาย · ฟอร์ม: ป้าย หรือชื่อ + เวลาที่สร้าง) และไม่สร้างใหม่เองถ้าค้นไม่พบ
- ข้อมูลเดิมใน D1 อยู่ครบเสมอ การย้ายขึ้น Google เป็นขั้นแยกที่ผู้ดูแลยืนยัน พร้อมจำนวน การจับคู่ และรายการที่อาจซ้ำ ทำซ้ำได้โดยไม่เกิดรายการซ้ำ (ใช้รหัสเดิม)

**log**: Worker log เฉพาะรหัสข้อผิดพลาดและเส้นทาง ไม่ log token, authorization code, cookie, เนื้อหาเอกสาร หรือข้อมูลติดต่อสมาชิก

## ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ

- **Google Sync ยังไม่ได้ตรวจกับ Google จริง**: Sheets, Calendar, Forms, การตรวจ revision ของ Docs, Google Picker และ scopes ของ Calendar ตรวจกับ Google จำลองในชุดทดสอบเท่านั้น ยังไม่มีการวัดความหน่วงจริง และยังไม่ได้ deploy
  สิ่งที่อาจต่างจากจริงและต้องตรวจตาม checklist: รูปแบบข้อผิดพลาดของแต่ละ API, การสร้างฟอร์มและสถานะเผยแพร่, พฤติกรรม `appendCells`/การจัดรูปแบบวันที่ของชีตที่มี locale ต่างกัน, sync token กับปฏิทินขนาดใหญ่, และหน้าต่าง Picker (ชุดทดสอบไม่ได้เปิด Picker จริง)
- **Docs บน production**: ผู้ดูแลยืนยันว่าเชื่อมแล้วและใช้งานได้ (รุ่นก่อน Google Sync) โครงการนี้ไม่ได้ตรวจซ้ำกับ Google จริงเอง
  ความเสี่ยงที่รู้: ถ้า Google ใส่รูปแบบเริ่มต้นบางอย่างในเอกสารใหม่ที่ตัวตรวจถือว่าเป็น “การจัดรูปแบบ” เอกสารจะถูกเปิดแบบอ่านอย่างเดียว (ปลอดภัยแต่ใช้ไม่ได้) ต้องตรวจตอน smoke test และปรับ `worker/docs.ts`
- **รุ่น Google Sync ยังไม่ได้ deploy**: ตรวจแค่ `wrangler deploy --dry-run` ยังไม่ได้ตรวจ Cron และ migration `0003` บน Cloudflare จริง (ใช้กับ D1 local และฐานทดสอบแล้ว)
- **ไม่ใช่ real time และไม่รับประกัน 60 วินาที**: ใช้ polling ไม่ใช้ push notification ของ Google ความหน่วงขึ้นกับรอบตรวจ (ประมาณ 60 วินาทีขณะมีคนเปิดหน้า, 5 นาทีจาก Cron ของ production) บวกเวลาตอบของ Google และ backoff เมื่อถูกจำกัดคำขอ
- **Sheets ไม่มี compare-and-swap ระดับแถว**: ยังมี race ช่วงสั้นระหว่างอ่านกับเขียน (ดูหัวข้อ Sheets ↔ ทะเบียนสมาชิก) ระบบตรวจพบและแจ้ง แต่กันไม่ได้
- ทะเบียนในชีตรองรับไม่เกิน 5,000 แถว · คำตอบของฟอร์มแสดง 300 รายการล่าสุด (สำเนาเก็บครบ) · ปฏิทินซิงค์ย้อนหลัง 400 วัน และกระจายกำหนดการซ้ำล่วงหน้า 400 วัน · แต่ละรอบซิงค์จำกัดจำนวนคำขอ ข้อมูลก้อนใหญ่จึงใช้หลายรอบ
- กำหนดการซ้ำ การลบกำหนดการ การลบ/จัดลำดับคำถาม และคำถามชนิดซับซ้อน ต้องทำใน Google โดยตรง
- สถานะ Testing ของ OAuth consent screen ทำให้การอนุญาตหมดอายุประมาณทุก 7 วัน การซิงค์จะหยุดจนกว่าจะเชื่อมใหม่ (ดูหัวข้อตั้งค่า Google Cloud)
- Workers แผนฟรีจำกัด subrequest ต่อคำขอ ระบบจึงจำกัดงบคำขอต่อรอบซิงค์ (24 ต่อบริการจากหน้าเว็บ, รวม 40 ต่อรอบ Cron แบ่งให้ทุกบริการ) ยังไม่ได้ตรวจกับขีดจำกัดจริงบน Cloudflare
- ตรวจ UI ด้วย Edge (Chromium) และ WebKit ของ Playwright บน Windows ที่ขนาดจอจำลอง **ไม่ได้ตรวจบน iPhone, Android, iPad หรือ Safari จริง** แป้นพิมพ์บนจอและการแตะจริงยังไม่ได้ตรวจ
- ไม่ได้ตรวจกับโปรแกรมอ่านหน้าจอ
- รายการทะเบียนสมาชิก/กำหนดการและเอกสารที่ลงทะเบียนใน editor เดิมยังโหลดครั้งเดียว ส่วนคลัง Google ใหม่โหลด metadata ทีละหน้า (สูงสุด 30 ไฟล์) และมีปุ่มโหลดเพิ่ม
- ผู้ดูแลลบข้อมูลสมาชิกเฉพาะเว็บได้จากหน้ารายละเอียด (ต้องมี migration `0007`) โดยคงแถว Google Sheets ไว้และกัน sync คืน member ID เดิม ดู [REVIEW_MEMBER_DELETE.md](REVIEW_MEMBER_DELETE.md) ยังไม่มีการลบกำหนดการหรือเอกสารจากเว็บ
- เปลี่ยนชื่อเอกสารจากเว็บไม่ได้หลังสร้าง ต้องเปลี่ยนใน Google Docs
- งานสร้างเอกสารที่ “ไม่ทราบผล” ต้องให้คนตัดสินใจ: ระบบค้นหาไฟล์เดิมให้ แต่ถ้าค้นไม่พบจะไม่สร้างใหม่เอง การยืนยันสร้างใหม่โดยผู้ใช้ยังมีโอกาสเกิดไฟล์ซ้ำถ้าไฟล์เดิมมีอยู่จริงแต่ค้นไม่พบ
- ถ้า Worker หยุดกลางงานสร้าง งานนั้นทำต่อได้หลัง lease หมด (สูงสุด 120 วินาที)
- ยังไม่มี rate limit ของตัวเอง (พึ่งการป้องกันของ Cloudflare) และตาราง `idempotency_keys`, `oauth_states`, `sessions` ที่หมดอายุยังไม่มีงานล้างตามเวลา (state ที่หมดอายุถูกลบเมื่อมีการเข้าสู่ระบบครั้งถัดไป)
- เซสชันหมดอายุระหว่างแก้เอกสาร: ร่างอยู่ในหน่วยความจำของหน้าที่เปิดอยู่เท่านั้น ถ้าปิดหรือโหลดหน้าใหม่ร่างจะหาย
- ยังไม่ทำ PWA / ใช้งานออฟไลน์

## ข่าวชมรมและปฏิทินหน้าแรกสมาชิก

หลังบ้านมีหน้า `/news` สำหรับทีมงานเพิ่ม/แก้ข่าวและเลือกร่าง เผยแพร่ หรือเก็บเข้าคลัง สมาชิกเห็นข่าวเผยแพร่พร้อมโปสเตอร์และลิงก์ Instagram ในหน้ากิจกรรม หน้าแรกสมาชิกมีเฉพาะปฏิทินเดือน/รายการจากกำหนดการชุดเดียวกับหลังบ้าน พร้อมรายละเอียดแบบอ่านอย่างเดียวและอัปเดตตามรอบขณะหน้าเปิดอยู่

ใช้ migration `0008_club_news.sql` และต้อง apply migrations ที่ค้าง (รวม `0007` จากงานลบสมาชิก) บน production ก่อน push ที่กระตุ้น deploy ข่าวสองรายการจากหน้าบ้านถูกนำเข้าเป็นสำเนาครั้งเดียว ยังไม่เชื่อม Instagram อัตโนมัติหรือส่งกลับอีก repo ดู [REVIEW_NEWS_CALENDAR.md](REVIEW_NEWS_CALENDAR.md) สำหรับสิทธิ์ API ข้อจำกัด และผลตรวจในเครื่องก่อนเผยแพร่

## งานที่มอบหมาย ข้อมูลติดต่อ และหน้าสมาชิกรุ่นถัดไป

เพิ่ม `/tasks` สำหรับทีมงานและ `/member/tasks` สำหรับสมาชิก รองรับงานเดี่ยวและหนึ่งกลุ่มต่อหนึ่งงาน ส่งไฟล์หรือลิงก์ ส่งหลังครบกำหนดได้พร้อมป้ายส่งล่าช้า สมาชิกแก้อีเมลและเลือกเพิ่มช่องทางติดต่อได้ ปฏิทินแสดงกิจกรรมหลายวันเป็นแถบต่อเนื่อง และทั้งระบบรองรับธีมมืด/สว่าง

เปลี่ยนรหัสผ่านสมาชิกต้องขอรหัสชั่วคราวจากผู้ดูแลก่อน ไม่มีการเปลี่ยนเองจากหน้า account และเอาปุ่มลบ/ปิดบัญชีที่ซ้ำออกจากรายละเอียดสมาชิก ต้อง apply `0009_tasks_profiles.sql` ก่อนใช้ Worker รุ่นนี้ รายละเอียด API สิทธิ์ ขนาดไฟล์ ที่เก็บ และข้อจำกัด Workers Free อยู่ใน [TASKS_AND_PROFILES.md](TASKS_AND_PROFILES.md)
