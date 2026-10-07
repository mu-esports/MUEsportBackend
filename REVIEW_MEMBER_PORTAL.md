# ผลตรวจบัญชีสมาชิกและคลังไฟล์ MU Esport

วันที่ตรวจ: 7 ตุลาคม 2569 — งานใน `C:\Myfiles\StaffMUEsite`

สถานะ: งานพัฒนาครบและชุดตรวจในเครื่องผ่าน รุ่นเตรียมเผยแพร่ใช้ tag `predeploy-member-portal-2026-10-07` แยกจาก `main` เพื่อไม่สั่ง production deploy ก่อนพร้อม การเปิดใช้จริงยังต้องยืนยัน runtime สำหรับรหัสผ่าน เตรียมฐานข้อมูล และทดลอง Google จริง

## เตรียมเผยแพร่วันที่ 7 ตุลาคม 2569

- ฐาน `main` คือ `0b7273c`; มีสิทธิ์ push ไป `mu-esports/MUEsportBackend` และไม่มี commit ใหม่จาก remote ขณะตรวจ
- ตรวจ Cloudflare แบบอ่านอย่างเดียว: Worker `muesportbackend` ผูก D1 production ถูกตัวและมี secrets เดิม สิทธิ์ Wrangler ที่มีอ่าน subscription/การตั้งค่า Builds ไม่ได้ (403) จึงยังยืนยัน Free/Paid ไม่ได้ ไม่เปลี่ยนแผนหรือค่าลับ
- `wrangler d1 migrations list DB --remote --env production --config wrangler.jsonc` พบ `0005_member_accounts_library.sql` ค้างอยู่ ยังไม่ได้ apply remote
- ตรวจ UI สมาชิกใหม่หลังแก้ login/กล่องหมดอายุ: ผ่าน 235/235; กล่องที่ปิดไม่ได้ใช้ `closedby="none"` และทดสอบ Esc ซ้ำไม่เกิด close event พร้อม focus ในกล่อง
- บันทึกลายนิ้วมือไฟล์ source 127 ไฟล์และเปรียบเทียบก่อน/หลังตรวจ ไม่มีไฟล์เปลี่ยนระหว่างรอบสุดท้าย; production build/typecheck และ deploy dry-run รันใหม่ผ่าน สแกน browser assets 224 ไฟล์ ไม่พบค่าลับของเครื่อง
- CI ตรวจ tag `predeploy-*` ด้วย รุ่นนี้ยังไม่ใช่การเปิดสมาชิกบน production ก่อนส่งเข้า `main` ต้องยืนยัน runtime/CPU และสำรอง/apply migration `0005` ตาม MEMBER_ACCESS.md

## ฟีเจอร์ที่ทำครบ

- สมาชิกเข้าสู่ระบบด้วยรหัสนักศึกษาและรหัสผ่าน มีการบังคับเปลี่ยนรหัสชั่วคราวครั้งแรก หน้าแรก กิจกรรม ไฟล์ชมรม และบัญชีของฉันใช้หน้าตาเรียบสีน้ำเงิน แยกจากหลังบ้าน
- ผู้ดูแลตั้ง/สุ่ม/รีเซ็ตรหัส ปิดบัญชี และยืนยันเปลี่ยนรหัสเข้าสู่ระบบได้ การพักสมาชิก ปิดบัญชี หรือรีเซ็ตรหัสทำให้ session เดิมใช้ไม่ได้ รหัสผ่านไม่ถูกส่งไป Google Sheets
- ทีมงานยังเข้าสู่ระบบด้วย Google สิทธิ์สมาชิกถูกตรวจฝั่ง server; บทบาท “ทีมงาน” ในทะเบียนสมาชิกไม่ทำให้บัญชีรหัสนักศึกษาได้สิทธิ์หลังบ้าน
- คลังรวมไฟล์ Google ที่บัญชีชมรมเข้าถึงได้ มีค้นหา กรอง เรียง โหลดเพิ่ม และสถานะข้อมูลล่าสุด ไม่ต้องเลือกลงทะเบียนทีละไฟล์ ไม่มีการเผยแพร่ไฟล์เป็น public
- Preview ของ Docs/Slides/Drawings เป็น PDF, Sheets เลือกแท็บ/หน้าข้อมูล, Forms แสดงคำถาม, PDF/ภาพ/ข้อความอ่านในเว็บ ชนิดที่รองรับไม่ได้ยังมีรายการและทางเปิดต้นฉบับ
- สร้าง Google Docs โดยตั้งชื่อในเว็บแล้วเปิด Google เพื่อแก้เนื้อหา มีตัวป้องกันทิ้งชื่อที่ยังไม่ได้สร้าง ตัวแก้ข้อความเดิมยังรองรับร่าง/ข้อผิดพลาด/conflict ที่ `/documents/:id/edit`
- ชีตเดิมจับคู่หรือเพิ่มคอลัมน์รหัสนักศึกษาได้ โดยไม่เปลี่ยน login ID ของสมาชิกเงียบ ๆ

สมาชิกเห็น **ไฟล์ทั้งหมดที่บัญชีชมรมเข้าถึงได้** ตามขอบเขตที่ผู้ใช้เลือก รวมถึงชีตทะเบียนที่อยู่ในบัญชีนั้น การเปิดต้นฉบับใน Google ใช้สิทธิ์ของบัญชี Google ของผู้เปิด การดู preview ในเว็บใช้ session สมาชิกและไม่ต้อง login Google

## สิ่งที่แก้เพิ่มเติมระหว่างตรวจ

- การคืน focus หลังปิด Picker รอให้ปุ่มเปิดใช้งานหลัง React แสดงผลแล้ว และคืนไปปุ่มที่เปิดหน้าต่างจริง
- เมื่อเปลี่ยนคำค้น/ตัวกรอง/การเรียง คลังแสดงกำลังโหลดแทนการแสดงรายการจากตัวกรองเก่า มีข้อทดสอบที่หน่วงคำตอบเพื่อยืนยันพฤติกรรมนี้
- คืนการเตือนก่อนทิ้งชื่อในหน้าสร้างเอกสาร และรองรับการออกจากระบบโดยไม่ค้างในคำเตือนซ้ำ
- ปรับชุดตรวจเดิมให้ตรงกับ “ไฟล์ชมรม”, URL preview และ URL editor โดยยังตรวจร่าง การบันทึก สิทธิ์ focus และข้อผิดพลาดเดิม
- ปรับตัวตรวจหน้าฟอร์มให้รอเนื้อหาฟอร์มพร้อม ข้อความของแถบซิงค์อาจปรากฏก่อนปุ่มตั้งค่าของฟอร์ม
- การตรวจเมนูใช้ `/files` โดยตรงเพื่อไม่กดระหว่าง `/documents` เปลี่ยนเส้นทาง ซึ่งอาจทำให้เมนูถูกปิดตามพฤติกรรมเมื่อเปลี่ยนหน้าใน WebKit การตรวจ URL เก่ายังคงรอและยืนยันปลายทาง `/files`
- CI รัน Worker tests ทีละไฟล์เพื่อลดการใช้หน่วยความจำ ชุด UI ใช้ฐานข้อมูลแยกและรันทีละชุด

## ผลตรวจ

| ชุด | ผล | ขอบเขต |
| --- | --- | --- |
| Worker | ผ่าน 290/290 (15 ไฟล์) | Workers runtime + D1 local; Google จำลอง |
| UI สมาชิก/บัญชี/คลัง/Picker | ผ่าน 235/235 ในรอบเตรียม push | Edge, viewport จำลอง; บัญชีและรหัสผ่านใช้ Worker/D1 จริงในเครื่อง |
| UI หลังบ้านเดิม | ผ่านครบ 552/552 ก่อนการแก้ login/กล่องหมดอายุเพิ่มเติม | Edge และ WebKit; Google จำลอง; ไม่รันเต็มซ้ำในรอบเตรียม push |
| UI ข้อมูลตัวอย่าง | ผ่าน 174/174 ในรอบก่อน | Edge; ข้อมูลในเบราว์เซอร์; ไม่รันซ้ำในรอบเตรียม push |
| Typecheck + production build | ผ่าน | ตรวจ frontend/config/Worker/tests แล้วสร้างไฟล์ production; ยังไม่ deploy |
| Wrangler dry-run | ผ่าน | ตรวจ package/binding โดยไม่เผยแพร่ |
| ค่าลับในไฟล์ส่งให้ browser | ผ่าน: 224 ไฟล์ พบค่าลับ 0 ไฟล์ | เปรียบเทียบ client secret และ encryption key ของเครื่อง/production โดยไม่แสดงค่า |

Build มีคำเตือน chunk JavaScript หลัก 663.18 kB ก่อน gzip (175.47 kB หลัง gzip) ไม่มีข้อผิดพลาดจาก typecheck/build ยังไม่ได้วัดเวลาการโหลดบนเครือข่ายมือถือจริง การตรวจ migrations ของฐานข้อมูลพัฒนาในเครื่องพบว่าไม่มี migration ค้าง รวมถึง `0005` ไม่ได้รัน migration บน production

## ข้อจำกัดที่ยังต้องทำก่อนเปิดใช้จริง

1. ระบบรหัสผ่านใช้ Argon2id `19 MiB, t=2, p=1` การวัด local ก่อนหน้านี้ประมาณ 135–149 ms ไม่ใช่ค่าที่วัด production จึงยังรับรองบน Workers Free ที่ให้ CPU 10 ms/HTTP request ไม่ได้ ต้องเลือก runtime/แผนที่รองรับและทดสอบก่อนเปิดบัญชีจริง ไม่มีการลดความแข็งแรงของ hash หรือซื้อแผนเพิ่มในงานนี้ ดู [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
2. ผู้ดูแลต้องให้สิทธิ์ `drive.readonly` จริง และตรวจข้อกำหนด Google สำหรับ restricted scope ตาม [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) รุ่นนี้ยังไม่ได้ตรวจ OAuth/ข้อมูลไฟล์จริง
3. Google Picker/GIS ในชุดสมาชิกเป็น stub; ยังไม่มีหลักฐานว่าหน้าต่าง Google จริงใน Brave หายจากปัญหา cookie การเปิดคลังและ preview ไม่ใช้ Picker
4. ทุกขนาดจอเป็น viewport จำลอง ไม่ใช่มือถือจริง ไม่ได้ตรวจ screen reader ทั้งระบบ โดยเฉพาะ PDF ที่แสดงด้วย canvas และไม่ได้ตรวจ browser zoom จริง
5. ก่อน push ที่ทำให้ Cloudflare deploy ต้อง apply migration `0005` บน production ตาม [MEMBER_ACCESS.md](MEMBER_ACCESS.md) รอบนี้ใช้เฉพาะ D1 local และไม่ได้เขียน Google จริง

## ภาพและหลักฐาน

ภาพใช้ข้อมูลสมมติ อยู่ใน `screenshots/` และไม่ได้รวมใน Git:

- `member-login-{1440,390}.png`, `member-home-{1440,390}.png`
- `member-files-{1440,390}.png`, `member-preview-{1440,390}.png`
- `member-account-{1440,390}.png`, `member-first-password-{1440,390}.png`
- `admin-member-account-{1440,390}.png`, `admin-set-password-{1440,390}.png`
- `staff-files-1440-dark.png`, `live-document-new-390.png`, `live-session-expired-scrolled-390-dark.png`

ผลรันและรายละเอียดแต่ละข้อเก็บใน `C:\Users\User\Documents\Codex\2026-10-04\fv\`:

- `member-worker-check.log`
- `member-ui-final-captures.log`
- `member-regression-live-final-2.log`
- `member-demo-check.log`
- `member-build-production.log`, `member-dry-run.log`
- `member-browser-assets-check.log`, `member-local-migration-check.log`
- รอบเตรียม push: `release-member-ui-current.log` (235/235), `release-production-build.log`, `release-dry-run.log`, `release-source-snapshot.json`

ขอบเขต API สิทธิ์ บัญชี การจับคู่ชีต และลำดับเปิดใช้จริงอยู่ใน [MEMBER_ACCESS.md](MEMBER_ACCESS.md)

## ลองในเครื่อง

เปิด dev server ไว้ที่ <http://localhost:5173/login> ตรวจหน้าเข้าสู่ระบบตอบ 200 และ API ยืนยันว่าตั้งค่า Google login แล้ว (ยังไม่ได้เข้าสู่ Google จริงในรอบนี้) ชุดตรวจที่เปิดเองปิด server ที่ 5174/5183 แล้ว

ผู้ดูแลเลือกส่วนทีมงานและใช้บัญชีชมรม จากนั้นเปิดหน้าสมาชิก กรอกรหัสนักศึกษาและตั้งรหัสชั่วคราวในรายละเอียดสมาชิก ก่อนให้สมาชิกเข้าสู่ระบบและเปลี่ยนรหัสครั้งแรก บัญชีในภาพและชุดตรวจเป็นข้อมูลสมมติในฐานข้อมูลทดสอบแยก ไม่ใช่บัญชีที่สร้างให้ใช้งานจริง
