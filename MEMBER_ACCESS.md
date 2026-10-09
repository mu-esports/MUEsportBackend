# บัญชีสมาชิกและคลังไฟล์ชมรม

เอกสารนี้อธิบายส่วนที่เพิ่มจากรุ่น Google Sync: ไม่ใช่ผลยืนยันว่าเปิดใช้บน production แล้ว การพัฒนาและชุดทดสอบใช้ D1 local และ Google จำลอง ไม่ทำให้ไฟล์ Google ถูกแชร์สาธารณะ

## หน้าจอและสิทธิ์

หน้า `/login` ใช้ฟอร์มเดียว ช่อง “ชื่อผู้ใช้” รับรหัสนักศึกษาของสมาชิกพร้อมรหัสผ่าน หรือพิมพ์ `google` แล้วกด “เข้าสู่ระบบ” เพื่อไป Google OAuth ของทีมงาน รับตัวพิมพ์ใหญ่เล็กเหมือนกันและล้างรหัสผ่านเมื่อเลือก Google ไม่มีสมัครบัญชีเอง ผู้ดูแลเปิดบัญชีจากรายละเอียดสมาชิกในหลังบ้าน การพิมพ์ `google` ไม่ให้สิทธิ์ admin; server ยังตรวจ Google identity และ role ตามเดิม

| การทำงาน | ผู้ไม่เข้าสู่ระบบ | สมาชิก | ทีมงาน staff | admin |
| --- | --- | --- | --- | --- |
| ดูข้อมูลตนเอง/แก้ช่องทางติดต่อ | ไม่ได้ | เฉพาะตนเอง | ไม่ได้ผ่าน API สมาชิก | ไม่ได้ผ่าน API สมาชิก |
| ดูกิจกรรม | ไม่ได้ | อ่านอย่างเดียว | จัดการหลังบ้าน | จัดการหลังบ้าน |
| อ่านรายการและ preview ไฟล์ Google ของชมรม | ไม่ได้ | ได้เมื่อคลังเปิดใช้แล้ว | ได้ | ได้ |
| อ่าน/จัดการทะเบียนสมาชิกทั้งหมด | ไม่ได้ | ไม่ได้ | ได้ | ได้ |
| ตั้ง/รีเซ็ตรหัสผ่าน ปิดบัญชี ยืนยันเปลี่ยนรหัสเข้าสู่ระบบ | ไม่ได้ | ไม่ได้ | ไม่ได้ | ได้ |
| ลบบัญชีเข้าสู่ระบบ (เก็บทะเบียนไว้) | ไม่ได้ | ไม่ได้ | ไม่ได้ | ได้ |
| ดู/จัดการโปรไฟล์นักกีฬา | ไม่ได้ | ไม่ได้ | ได้ | ได้ |
| อ่านรูปโปรไฟล์ | ไม่ได้ | เฉพาะตนเอง | ทุกคนในทะเบียน | ทุกคนในทะเบียน |
| ตั้ง/เปลี่ยน/ลบรูปโปรไฟล์ | ไม่ได้ | ไม่ได้ | ได้ | ได้ |
| เปลี่ยนรหัสผ่านของตนเอง/ออกจากระบบ | ไม่ได้ | ได้ | ออกจากระบบได้ | ออกจากระบบได้ |
| คำถาม/คำตอบ Forms ที่จับคู่ในเครื่องมือหลังบ้าน | ไม่ได้ | ไม่ได้ (preview คลังแสดงเฉพาะคำถาม) | ได้ตามสิทธิ์เดิม | ได้ |
| จัดการทีมงาน/เชื่อม Google/ตั้งค่าแหล่งซิงค์ | ไม่ได้ | ไม่ได้ | อ่านสถานะได้ แต่จัดการไม่ได้ | ได้ |

บทบาทในทะเบียนสมาชิกไม่ใช่สิทธิ์หลังบ้าน แม้ทะเบียนระบุว่า “ทีมงาน” หรือ “ผู้ดูแล” session ที่เข้าด้วยรหัสนักศึกษายังคงเป็นสมาชิก ทุก API ตรวจชนิด session ที่ server สมาชิกที่ใช้รหัสชั่วคราวเข้าถึงได้เฉพาะข้อมูล session การเปลี่ยนรหัสผ่าน และ logout จนกว่าจะเปลี่ยนรหัสสำเร็จ

สมาชิกอ่าน **ไฟล์ Google ทั้งหมดที่บัญชีชมรมเข้าถึงได้** ตามที่เจ้าของระบบยืนยัน รวมชีตที่มีเนื้อหาภายในชมรม ไม่มีระบบคัดเลือกเผยแพร่ทีละไฟล์ การอ่านคลังไม่ให้สิทธิ์เรียก API หลังบ้านหรือเขียน Google

## การเพิ่มรอบทะเบียนนักกีฬาและรูป

ส่วนนี้ใช้ migration `0006_account_revision_athletes_photos.sql` และต้อง migration ฐานข้อมูลก่อนใช้ Worker รุ่นใหม่ ดูขั้นเผยแพร่และ API ใน [ROSTER_RELEASE.md](ROSTER_RELEASE.md) ผลตรวจในเครื่องไม่ใช่ผลยืนยันการใช้งาน Google production

- ลบบัญชีเข้าสู่ระบบแยกจากปิดบัญชีชั่วคราว ลบ verifier/session ของคนนั้น แต่ไม่ลบทะเบียน รูป นักกีฬา หรือ Google Sheets การยืนยันผูก revision เพื่อไม่ลบบัญชีที่ถูกรีเซ็ต/สร้างใหม่จากอีกแท็บ
- นักกีฬาเป็นโปรไฟล์เพิ่มเติมของ member ID เดิม หน้า `/athletes` แยกจากทะเบียนสมาชิกแต่ไม่สร้างบัญชีซ้ำ ไม่ให้สิทธิ์ staff/admin และไม่นับสมาชิกซ้ำในภาพรวม ถอดโปรไฟล์แล้วทะเบียนและบัญชียังอยู่
- รูปบุคคลใช้ร่วมกันในสมาชิก นักกีฬา และหน้าบัญชีตนเอง เก็บไฟล์ที่ย่อแล้วใน D1 ตารางแยก รายการอ่านเฉพาะ version ไม่มี binary/base64 ใน JSON รายชื่อ
- JPEG/PNG/WebP ต้นฉบับไม่เกิน 5 MB ถูก crop ตรงกลางและย่อใน browser ไม่เกิน 512×512 และ 256 KiB; server ตรวจ signature/dimensions และหยุดอ่านเมื่อ body เกินเพดานแม้ไม่มี Content-Length
- รูปอ่านผ่าน endpoint ของเว็บที่ตรวจ session/สิทธิ์ทุกครั้ง สมาชิกอ่านได้เฉพาะของตนเอง ไม่มี public URL สมาชิกยังเปลี่ยนรูปเองไม่ได้
- หมวดไฟล์ “ทั้งหมด / Google Docs / Google Sheets / Google Forms” ใช้ API ตาม MIME type และ shortcut target ไม่กรองแค่หน้าแรก มี query/deep link/pagination แยกตามหมวด เครื่องมือ sync Forms เดิมยังอยู่ที่ `/forms`


หน้า `/member` ใช้ header/bottom navigation แบบเรียบสีฟ้า มี `/member/activities`, `/member/files`, `/member/files/:id`, `/member/account` และ `/member/password` พื้นผิวสว่างแยกจากธีมหลังบ้าน แชร์ `FileList`/`FilePreview`, date formatting, Dialog และ API client แต่ไม่ครอบด้วย StoreProvider/SyncProvider ของทีมงาน

หลังบ้านใช้ `/files` และ `/files/:id` เป็นคลังเดียวกัน พร้อมปุ่มแก้ในโปรแกรม Google เมื่อ metadata บอกว่าแก้ได้ `/documents` พาไป `/files`; ลิงก์เอกสารเก่า `/documents/:id` พาไป preview ของ Google file ID ส่วน `/documents/:id/edit` ยังรักษา editor ข้อความเดิมและร่างที่ค้างไว้ ไม่มีการแก้เอกสาร Google จริงในการทดสอบ

## API ของส่วนที่เพิ่ม

ทุก API สมาชิกผูกกับ member ID ใน session ไม่รับ ID ของคนอื่น รหัสผ่านไม่ปรากฏในคำตอบ JSON หรือ Sheets คำสั่งที่มี session ต้องส่ง Origin ของเว็บและ `X-CSRF-Token` จาก `/api/session` การ login ตรวจ Origin ก่อนรับข้อมูล ไม่ใช้ CSRF token ที่ยังไม่มี session

| Method / URL | ผู้ใช้ | Request / Response หลัก |
| --- | --- | --- |
| `POST /auth/member/login` | ไม่ต้องมี session | `{studentId,password}` → `{ok,mustChangePassword}` พร้อม cookie HttpOnly; ข้อมูลผิดตอบ `invalid_credentials` โดยไม่บอกว่ามีบัญชีหรือไม่ |
| `GET /api/session` | ทุกคน | `user` (ทีมงาน) หรือ `member` (สมาชิก) พร้อม `csrfToken`; anonymous ทั้งคู่เป็น null |
| `POST /auth/logout` | ทุก session | ยกเลิก session นี้และล้าง cookie ไม่ตัดการเชื่อม Google ของชมรม |
| `POST /api/members/:id/account/password` | admin | `{studentId,password}` → `{account}`; เปิด/เปิดกลับ/รีเซ็ตรหัสชั่วคราวและยกเลิก session เดิม |
| `POST /api/members/:id/account/disable` | admin | `{}` → `{account}`; ปิดบัญชีและยกเลิก session เดิม ไม่ลบทะเบียน |
| `POST /api/members/:id/account/login-id` | admin | `{studentId}` ที่ตรงกับทะเบียนล่าสุด → `{account}`; เปลี่ยน login ID โดยยังผูกสมาชิกคนเดิมและยกเลิก session เดิม |
| `GET/POST /api/setup/student-id-column` | admin | อ่านหัวคอลัมน์และเลือก `{header}` หรือเพิ่มด้วย `{add:true}` เพื่อให้ชีตเดิมซิงค์รหัสนักศึกษาได้ |
| `GET /api/member/me` | สมาชิก | `{member}` เฉพาะชื่อ ชื่อเล่น รหัสนักศึกษา/login ID สถานะ contact version และความสามารถแก้ contact; ไม่มีหมายเหตุทีมงาน |
| `PATCH /api/member/me` | สมาชิก | `{contact,expectedVersion}` → `{member}`; ถ้ามาจากชีต เขียนเฉพาะ contact ของแถวตนเองด้วยระบบ sync เดิม |
| `POST /api/member/password` | สมาชิก รวมรหัสชั่วคราว | `{currentPassword,newPassword}` → `{ok,csrfToken}` พร้อม session ใหม่; ยกเลิก session เก่าทั้งบัญชี |
| `GET /api/member/events` | สมาชิก | `{events}` กิจกรรมที่ยังไม่จบและย้อนหลัง 30 วัน สูงสุด 400 รายการ; อ่านอย่างเดียว |
| `GET /api/library/status` | staff/admin/สมาชิกที่เปลี่ยนรหัสแล้ว | ความพร้อมของคลัง; member ไม่ได้รับรายละเอียดการตั้งค่า Google |
| `GET /api/library/files` | เหมือนข้างบน | `q`, `type`, `sort`, `pageToken`, `limit`, `fresh=1`; ส่ง `{files,nextPageToken,incomplete,fetchedAt,stale,pageSize}` ไม่โหลดเนื้อหาทุกไฟล์ |
| `GET /api/library/files/:id` | เหมือนข้างบน | metadata, ชนิด preview และลิงก์ต้นฉบับ; resolve shortcut และตรวจสิทธิ์ปลายทางกับ Google |
| `GET /api/library/files/:id/content` | เหมือนข้างบน | stream PDF/รูปภาพผ่าน server ที่ตรวจ session; รองรับ Range ของไฟล์ดาวน์โหลดและไม่ cache เนื้อหาส่วนตัว |
| `GET /api/library/files/:id/text` | เหมือนข้างบน | preview ข้อความสูงสุด 512 KiB; JSON escape ไม่รัน HTML |
| `GET /api/library/files/:id/sheet` | เหมือนข้างบน | preview ชีตตามแท็บ สูงสุด 200 แถว/40 คอลัมน์ต่อหน้า ไม่แสดงเป็นทั้งไฟล์ถ้ายังมีข้อมูลอีก |
| `GET /api/library/files/:id/form` | เหมือนข้างบน | preview คำถามของ Forms ไม่รวมคำตอบผู้กรอก |
| `POST /api/google/connect` | admin | `{service:"library",returnTo:"/files"}` → `authUrl`; ขออ่านทั้งคลังผ่านบัญชีชมรมเพียงบัญชีเดียว |

คลัง list อ่านสำเนา metadata ชั่วคราวและบอก `fetchedAt`/`stale` หาก Google ล้มเหลว การเปิดเนื้อหาแต่ละครั้งตรวจสิทธิ์กับ Google ใหม่ ไฟล์ถูกลบ/ถังขยะ/ถอนการแชร์มีสถานะเปิดไม่ได้ ไม่ตอบว่าคลังว่างแทน error ไม่มี Google token ส่งให้ member browser

Docs/Slides/Drawings ส่งออกเป็น PDF, PDF และรูปภาพแสดงผ่าน server, Sheets เป็นตาราง, Forms เป็นคำถาม, plain text แสดงข้อความ HEIC/Office/ชนิดอื่นที่ Google มีภาพย่อใช้ภาพย่อนั้นแสดงตัวอย่าง พร้อมบอกว่าไม่ใช่ความละเอียดเต็ม ไฟล์ที่ไม่มีตัวอย่างยังอยู่ในคลังพร้อมปุ่มต้นฉบับ ไฟล์ทั่วไปสูงสุด 25 MiB; Google จำกัด export PDF ที่ 10 MB การเปิดต้นฉบับขึ้นกับสิทธิ์ของบัญชี Google ของผู้กด ไม่ได้เพิ่มสิทธิ์ Google ให้สมาชิกอัตโนมัติ ตัวแสดง PDF เป็น canvas ยังไม่ได้ยืนยันกับ screen reader

การ์ดในหน้าคลังโหลดภาพใกล้หน้าจอครั้งละไม่เกิน 4 ภาพ แสดงรายการก่อนภาพเสร็จและยกเลิกคำขอเมื่อออกจากหน้า ภาพย่อเก็บชั่วคราวใน Cache API ภายใน Worker ไม่เกิน 5 นาที โดยตรวจ metadata/สิทธิ์จาก Google ใหม่ก่อนส่งภาพทุกครั้ง และแยก cache ตามรุ่นภาพ คำตอบถึง browser เป็น `private, no-store` รายการที่ใช้เมื่อกลับจากตัวอย่างอยู่เฉพาะหน่วยความจำ 60 วินาที แยกตามชนิด/รหัสผู้ใช้ มีการตรวจรายการใหม่เสมอ ไม่เก็บไฟล์ใน localStorage

## บัญชี รหัสผ่าน และรหัสนักศึกษา

รหัสนักศึกษาเป็น string เก็บเลขศูนย์นำหน้าได้ ไม่กำหนดความยาวตายตัว สมาชิกเดิมยังไม่มีรหัสต้องกรอกก่อนเปิดบัญชี รหัสไม่ซ้ำแบบไม่สนตัวพิมพ์อังกฤษ ใช้ member ID ที่เสถียรผูกบัญชี การเปลี่ยนรหัสในทะเบียน/Sheets ไม่เปลี่ยน login ID เงียบ ๆ ผู้ดูแลต้องยืนยันที่ส่วนบัญชี หากชีตมีรหัสซ้ำหรือไม่ถูกต้อง จะแสดงปัญหาและกันการเปิดบัญชีใหม่ของแถวนั้น

สำหรับชีตที่เชื่อมไว้ก่อนรุ่นนี้ เปิด “แหล่งข้อมูล” → “จับคู่คอลัมน์รหัสนักศึกษา” แล้วเลือกคอลัมน์เดิมหรือเพิ่มคอลัมน์ใหม่ หากยังไม่จับคู่ รหัสที่กรอกในเว็บเก็บเฉพาะในเว็บ ไม่มีการเดาคอลัมน์หรือเขียนทับคอลัมน์อื่น ชุดข้อมูลที่สร้างใหม่มีคอลัมน์รหัสนักศึกษาให้แล้ว รหัสผ่านไม่ถูกส่งไป Google Sheets

ผู้ดูแลตั้งรหัสชั่วคราว 10–128 ตัวอักษร (มีปุ่มสุ่ม) สมาชิกต้องเปลี่ยนครั้งแรก ไม่มีทางอ่านรหัสเก่ากลับ ไม่ส่งรหัสทางอีเมลอัตโนมัติ การพักสมาชิก รีเซ็ต หรือปิดบัญชีทำให้ session เดิมใช้ไม่ได้ สมาชิกติดต่อทีมงานเมื่อลืมรหัสผ่าน

รหัสนักศึกษาตัวเลขรับได้ทั้ง `u/U` นำหน้าและตัวเลขล้วน เช่น `u6501234` / `6501234` (รหัสสมมติ) เก็บรายการใหม่เป็นข้อความตัวเลข คงเลขศูนย์นำหน้า บัญชีเดิมยังใช้ได้ ถ้าข้อมูลเก่ามีทั้งสองรูปแบบอยู่คนละบัญชี จะปฏิเสธ login แทนการเลือกตัวตนจากรหัสผ่าน ตัวนับ login ของทั้งสองรูปแบบเป็นชุดเดียวกัน

**Workers Free:** ใช้ server relief ตาม [แนวทาง Libsodium](https://libsodium.gitbook.io/doc/password_hashing#server-relief) เบราว์เซอร์คำนวณ Argon2id `m=19456 KiB,t=2,p=1` ด้วย salt สุ่ม 16 ไบต์และผล 32 ไบต์ใน Web Worker แล้ว Cloudflare ทำ HMAC-SHA-256 อีกชั้นก่อนเก็บ D1 รูปแบบ `$mu-argon2id$v=1$…` กุญแจ HMAC แยกโดเมนจาก `TOKEN_ENCRYPTION_KEY` ไม่ส่งไปเบราว์เซอร์ ไม่เก็บผลชั้นแรกใน D1 และผูก verifier กับ member ID จึงนำ hash ในฐานข้อมูลมายิง login ตรง ๆ หรือย้ายไปบัญชีอื่นไม่ได้ ไม่ลด work factor ไม่ซื้อแผนเพิ่ม

`POST /auth/member/challenge` รับ `{studentId}` คืนเฉพาะ salt/พารามิเตอร์พร้อม `no-store` บัญชีที่ไม่มีใช้ salt จำลองแบบคงที่ตามรหัส (ทั้งสองรูปแบบได้ค่าเดียวกัน) ไม่มีธงบอกว่ามีบัญชี login ส่ง `{studentId,passwordProof}`; ตั้งรหัสและเปลี่ยนรหัสส่ง proof เพิ่มพร้อมช่องเดิมเพื่อคง validation ความยาวและรหัสใหม่ต่างจากเดิม ใช้ HTTPS เสมอ ผลชั้นแรกถือเป็น credential จึงห้ามบันทึกลง log, localStorage หรือส่งทาง URL

บัญชี Argon2id เดิมแปลงเป็น HMAC wrapper เมื่อขอ challenge โดยไม่คำนวณ Argon2 บน Worker ถ้าพารามิเตอร์เดิมอ่อนกว่าปัจจุบันต้องเปลี่ยนรหัสหลัง login ตัวนับอยู่ D1: 5 ครั้งต่อรหัส / 30 ครั้งต่อ IP ใน 15 นาที พัก 15 นาทีและเพิ่มเมื่อผิดซ้ำ สูงสุด 24 ชั่วโมง; challenge จำกัดแยก 120 ครั้ง/IP/15 นาที การตั้งรหัสใหม่ล้างการพักของรหัสนั้น การเปลี่ยนกุญแจต้องมีแผนย้ายทั้ง Google tokens และ password verifiers ห้ามเปลี่ยนกุญแจเดิมโดยไม่ย้ายข้อมูล

`PASSWORD_HASH_MODE=client` ใช้ทุก environment ที่เปิดเว็บ การคำนวณรหัสบนเซิร์ฟเวอร์แบบเก่ามีเฉพาะ `server-test` ใน bindings ของ Vitest เพื่อรักษาชุดตรวจเก่า ไม่ใส่ค่านี้ใน Cloudflare เบราว์เซอร์ที่เตรียม proof ไม่สำเร็จแสดงข้อผิดพลาดและให้ลองใหม่ ไม่มีการลดความแข็งแรงหรือตัดไปใช้ hash แบบเร็ว

อ้างอิง [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) และ [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

## ขั้นเปิดใช้จริง (ทำหลังอนุมัติรุ่นนี้)

1. ใช้ Workers Free ได้ด้วย client work + server verifier ข้างต้น ต้องทดลอง flow เข้าสู่ระบบ/เปลี่ยนรหัสบน runtime จริงก่อนเปิดบัญชีสมาชิก
2. Google Cloud ของ OAuth client เดิม → Google Auth Platform → Data Access เพิ่ม `https://www.googleapis.com/auth/drive.readonly` เปิด Drive/Docs/Sheets/Forms API เดิมให้ครบ การ preview ไม่ต้องใช้ Picker key; key เดิมยังใช้สำหรับตั้งค่าแหล่งซิงค์
3. `drive.readonly` เป็น restricted scope: ตรวจข้อกำหนด verification และ security assessment ตามรูปแบบการให้บริการ ขณะ Testing บัญชีชมรมและทีมงาน Google ต้องอยู่ใน Test users สมาชิกที่ login ด้วยรหัสนักศึกษาไม่ต้องเป็น Google Test user ดู [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
4. สำรอง/ตรวจฐานข้อมูล production แล้วใช้ migration `0005` **ก่อน push** ที่ทำให้ Cloudflare deploy อัตโนมัติ: `npx.cmd wrangler d1 migrations apply DB --remote --env production` คำสั่งใช้เฉพาะ migration ที่ยังไม่ apply ไม่แก้ migrations 0001–0004 ไม่เปลี่ยน TOKEN_ENCRYPTION_KEY
5. เมื่ออนุมัติแล้วจึง push/build/deploy ตาม README ระบบเก่ายังทำงานได้หลัง migration (สมาชิกเดิมได้ student ID ว่าง) ใช้ Worker `muesportbackend` เดิม ห้ามแตะ `mu-esports-website`
6. ผู้ดูแลเข้าสู่ระบบด้วยบัญชีชมรม เปิด “ไฟล์ชมรม” → “เปิดใช้คลังไฟล์ Google” อนุญาตอ่าน Drive เพิ่ม **ต้องทำ consent จริง** คลังไม่พร้อมจนกว่า server ยืนยันว่าได้รับ scope แล้ว
7. ทดลองกับ Google จริงโดยไม่แชร์ไฟล์ public: ไฟล์เก่า/ไฟล์แชร์ใหม่ปรากฏ ค้นหา/โหลดเพิ่มเปิดได้ preview Docs/Sheets/Forms/PDF ใช้ได้โดยสมาชิกไม่ login Google แก้ต้นฉบับใน Google แล้วกดโหลดล่าสุดในเว็บ ตรวจไฟล์ถูกถอนสิทธิ์และ error ไม่แสดงว่าไม่มีไฟล์
8. ผู้ดูแลเพิ่ม student ID → ตั้งรหัส → สมาชิกเปลี่ยนครั้งแรก → ดูกิจกรรม/ไฟล์/ข้อมูลตนเอง → reset/disable/suspend แล้ว session เก่าใช้ไม่ได้ ตรวจทั้ง desktop/mobile และ Brave Picker จริงต่างหาก

## การตรวจในเครื่อง

รัน Worker tests, UI live และ UI member ทีละชุด ชุด UI สองชุดใช้ `.wrangler/ui-test-state` กับพอร์ต 5183 เดียวกัน ห้ามรันพร้อมกันหรือใช้ฐานข้อมูลพัฒนาปกติแทน (ถ้าจำเป็นต้องรันซ้อน ตั้ง `UI_LIVE_PORT` และ `UI_STATE_DIR` ของแต่ละชุดให้ต่างกัน) ชุด demo ต้องเปิด dev:demo ที่ 5174 ไม่มีระบบสมาชิก/Google

`npm run check:ui:member` ใช้ Worker/D1/password จริงในเครื่อง แต่รายการ/เนื้อหา Google ใช้ตัวจำลอง และ Google Picker/GIS ใช้ stub จึงยืนยันได้เฉพาะ lifecycle ของหน้าเว็บ ไม่มีหลักฐานว่าปัญหา Google popup จริงใน Brave หายแล้ว Screenshots อยู่ `screenshots/member-*`, `screenshots/admin-*`, `screenshots/staff-*` ผลที่รันและข้อจำกัดของรุ่นที่ส่งดูได้จากรายงานตรวจล่าสุดของงาน
