# Login, บัญชีสมาชิก, หมวดไฟล์, นักกีฬา และรูปบุคคล

## ขอบเขต

รับช่วง source ที่ Claude ทำค้างไว้ ไม่สร้างโครงการใหม่ ใช้ Cloudflare Workers Free + D1 เดิม ไม่มีบริการเก็บรูปเพิ่มเติม การเปลี่ยนแปลงรอบนี้อยู่ในเครื่องและต้องใช้ migration 0006 ก่อนใช้ Worker ใหม่

หน้า login ใช้ฟอร์มเดียว ช่องชื่อผู้ใช้ไม่มีรหัสตัวอย่างหรือคำอธิบายรูปแบบ สมาชิกยังใช้รหัสนักศึกษาที่มี u/U หรือเลขล้วนตามเดิม ส่วน `google` ทุก case เริ่ม Google OAuth หลังผู้ใช้กดปุ่มหรือ Enter ไม่ต้องกรอกรหัสผ่านและไม่ส่งคำขอเข้าสู่ระบบสมาชิก

ลบบัญชีทำได้เฉพาะ admin: ลบบัญชีเข้าสู่ระบบและ member sessions ของคนนั้น เก็บทะเบียน รูป โปรไฟล์นักกีฬาและข้อมูล Google ไว้ ถ้า revision เปลี่ยนหลังเปิด dialog ให้ตรวจบัญชีล่าสุดก่อนยืนยันอีกครั้ง เปิดบัญชีใหม่ได้ภายหลัง แต่ session เดิมไม่กลับมาใช้ได้

นักกีฬาเป็นข้อมูลเพิ่มเติมของบุคคลในทะเบียนสมาชิก ผูก member ID เดิม ชื่อ/ชื่อเล่น/รหัส/รูปไม่ถูกคัดลอกเป็นคนที่สอง มีเกม ทีม ตำแหน่ง IGN สถานะ และหมายเหตุ ไม่เปลี่ยน auth role และไม่เพิ่มจำนวนสมาชิกซ้ำในภาพรวม ข้อมูลนักกีฬาและรูปอยู่ในตารางแยกที่ Sheets sync ไม่ล้าง

## API เพิ่ม

| Endpoint | สิทธิ์/พฤติกรรม |
| --- | --- |
| `GET /api/members/:id/account` | staff/admin อ่านสถานะบัญชีพร้อม revision |
| `POST /api/members/:id/account/delete` | admin + Origin/CSRF; body `{expectedRevision}`; revision ต่างตอบ 409; บัญชีไม่มีแล้วตอบสถานะปัจจุบัน |
| `GET /api/athletes` | staff/admin อ่าน roster |
| `POST /api/athletes` | staff/admin; memberId + game/team/position/ign/status/note; memberId ซ้ำตอบ 409 พร้อมข้อมูลปัจจุบัน |
| `PATCH /api/athletes/:memberId` | staff/admin; ข้อมูลนักกีฬา + expectedVersion; conflict ตอบ 409 |
| `POST /api/athletes/:memberId/remove` | staff/admin + expectedVersion; ลบเฉพาะโปรไฟล์นักกีฬา |
| `GET /api/members/:id/photo` | staff/admin หรือสมาชิกเจ้าของรูป; private/no-cache, ETag; ตรวจ session ก่อน 304 |
| `PUT /api/members/:id/photo` | staff/admin + Origin/CSRF; binary JPEG/PNG/WebP ≤256 KiB, dimensions ≤512×512 |
| `DELETE /api/members/:id/photo` | staff/admin + Origin/CSRF; ลบรูปเท่านั้น |

PUT ตรวจขนาดจาก stream ขณะอ่าน ไม่เก็บ body ใหญ่เต็มก่อนปฏิเสธ ตรวจ type/dimensions จากเนื้อไฟล์แทนการเชื่อชื่อไฟล์หรือ Content-Type ไม่ทำ image conversion หนักบน Worker รุ่นรูปเป็น hash ของ bytes; metadata lists ส่งเฉพาะ version ไม่ส่ง bytes

หมวดไฟล์ใช้ endpoint เดิม `/api/library/files?type=doc|sheet|form` มี pagination/cached query แยกตามชนิด รวม shortcut จาก MIME target ภายในเพดานการอ่านต่อคำขอ หากยังมีหน้าแต่ยังไม่พบไฟล์ให้แสดง “ยังมีรายการให้ตรวจต่อ” แทนสรุปว่าไม่มีไฟล์ ปุ่มเครื่องมือ Forms เดิมไม่ถูกแทนด้วยหมวดไฟล์

## ตรวจในเครื่อง

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run check:ui:roster
npm run check:ui:member
npm run build
npx.cmd wrangler deploy --dry-run
```

UI scripts ใช้ Worker และ D1 local จริง แยก state ที่ `.wrangler/ui-test-state` พอร์ต 5183; Google library/OAuth บางส่วนเป็น mock/stub ตามรายงาน ไม่ใช่ Google จริง ห้ามรันสอง UI scripts ที่ใช้ state/port เดียวกันพร้อมกัน สคริปต์เปิดและปิดเฉพาะ test server/browser ของตัวเอง

## ขั้นเผยแพร่ภายหลัง

1. ตรวจ diff/results ของ source ล่าสุด เก็บ credentials และ binary/screenshot นอก Git
2. สำรอง D1 production ตามวิธีเดิม รัน `npx.cmd wrangler d1 migrations list DB --remote --env production` ตรวจว่า 0006 ยัง pending และไม่มี migration ที่ไม่คาดไว้
3. เมื่อได้รับคำสั่งเผยแพร่ ให้รัน `npx.cmd wrangler d1 migrations apply DB --remote --env production` ก่อน push/deploy Worker ใหม่
4. Build production ตาม README แล้ว push/deploy Worker `muesportbackend` เท่านั้น ไม่แตะ `mu-esports-website` และไม่เปลี่ยนค่าลับ/แผนบริการ
5. ตรวจ login สมาชิก/Google, หมวดไฟล์จริง, session หลังลบบัญชีทดสอบที่ผู้ใช้อนุญาต, รูป และนักกีฬาบน production โดยไม่ใช้สมาชิกจริงเพื่อทดสอบ destructive flow

0006 เพิ่ม revision ให้บัญชีเดิมโดยไม่เปลี่ยน verifier/login ID/session และเพิ่มตาราง athletes/member_photos การย้อน Worker ใช้ source ก่อน 0006 ได้เนื่องจากข้อมูลเดิมยังอยู่ แต่หากมี Worker เก่าบันทึกบัญชีหลัง rollback ควรตรวจ revision semantics ก่อนเผยแพร่ Worker ใหม่อีกครั้ง ไม่ย้อน schema ด้วยการลบทะเบียนหรือบัญชี

## ข้อจำกัด

รูปเป็น avatar ขนาดเล็ก ไม่ใช่คลังรูปต้นฉบับหรือ crop editor ที่ปรับด้วยมือ นักกีฬาหนึ่งคนมีโปรไฟล์หนึ่งชุดเกม/ทีมในรอบนี้ สมาชิกทั่วไปไม่มีเมนู roster และแก้รูปเองไม่ได้ หมวดไฟล์ไม่เชื่อม Sheets/Forms เป็นแหล่ง sync ใหม่โดยอัตโนมัติ

ผลตรวจ source ล่าสุดและ screenshot ที่เปิดดูอยู่ใน [REVIEW_ROSTER.md](REVIEW_ROSTER.md)

## เตรียมเผยแพร่ 9 ตุลาคม 2569

ผู้ใช้สั่ง push ขึ้น GitHub แล้ว สำรอง D1 production ไว้นอก repository จากนั้น apply เฉพาะ migration 0006 สำเร็จก่อน push เพื่อรองรับ Workers Builds ที่ deploy จาก main อัตโนมัติ ไม่เปลี่ยนข้อมูลสมาชิก/รหัสผ่าน/Google connection เดิม ไม่แตะ Worker อื่น Build production และ production dry-run ผ่าน ตรวจค่าลับที่ทราบใน browser build 225 files ไม่พบค่าเหล่านั้น ชุดทดสอบ Google ที่อ้างในรายงานยังใช้ตัวจำลอง ต้องตรวจ Google จริงภายหลัง
