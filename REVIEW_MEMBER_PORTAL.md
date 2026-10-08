# ผลตรวจและเผยแพร่ MU Esport Staff

วันที่ตรวจล่าสุด: 8 ตุลาคม 2569

## สถานะออนไลน์

- โค้ด `eb51800` push เข้า `main` ของ `mu-esports/MUEsportBackend` และ deploy Worker `muesportbackend` แล้ว
- เว็บ: <https://muesportbackend.muesport2567.workers.dev/login>
- Deployment ที่ตรวจ: `1bbe5e11-1d53-41aa-bfd2-54379affb405`
- ใช้ Workers Free เดิม ไม่อัปเกรดแผน ไม่เปลี่ยนค่าลับหรือกุญแจเดิม และไม่แก้ Worker `mu-esports-website`
- สำรอง D1 production ไว้นอก Git ก่อน apply `0005_member_accounts_library.sql` ซึ่งผ่านแล้ว ไม่เปลี่ยน migrations 0001–0004

## การเข้าสู่ระบบและข้อมูลตัวอย่าง

รหัสนักศึกษารับทั้งมี `u/U` นำหน้าและตัวเลขล้วน เช่น `u6501234` / `6501234` (รหัสสมมติ) เป็นบัญชีเดียวกัน คงเลขศูนย์นำหน้า และใช้ตัวนับ login ชุดเดียวกัน ไม่พบรหัสตัวอย่างส่วนตัวของผู้ใช้ใน source ที่เผยแพร่

เบราว์เซอร์คำนวณ Argon2id `m=19456,t=2,p=1` ใน Web Worker ส่วน Cloudflare ตรวจและเก็บ HMAC อีกชั้นที่ผูกกับ member ID ใช้กุญแจแยกโดเมนจาก secret เดิม ผลชั้นแรกไม่อยู่ใน D1 หรือ browser storage และ verifier ในฐานข้อมูลใช้ยิง login ตรง ๆ ไม่ได้ ค่าความแข็งแรงของ Argon2id ไม่ลดลง ดูรายละเอียด protocol/การย้ายบัญชีเดิมใน MEMBER_ACCESS.md

## ผลตรวจของ source รุ่นนี้

| ชุดตรวจ | ผล | ขอบเขต |
| --- | --- | --- |
| Typecheck ทุกส่วน | ผ่าน | frontend/config/Worker/tests |
| Worker บน GitHub CI | 300/300; 16 ไฟล์ | workerd + D1 local; Google จำลอง |
| UI สมาชิก/บัญชี/คลัง | 243/243 | Edge จริง, viewport จำลอง; Google จำลองและ Picker stub |
| Production build และ dry-run | ผ่าน | ตรวจ Worker/D1 bindings ตรง production |
| สแกน browser assets | 225 ไฟล์; พบค่าลับ 0 | ไม่รวม server bundle ที่อยู่ใน dist และไม่ถูกส่งให้ browser |
| สแกนไฟล์ Git ก่อน commit | 140 ไฟล์; พบค่าลับ/ไฟล์ต้องห้าม 0 | credential files, dev vars และค่าลับจริงไม่ถูก push |

CI ของ source เดียวกันผ่านทั้ง tag และ main:

- <https://github.com/mu-esports/MUEsportBackend/actions/runs/37727973976>
- <https://github.com/mu-esports/MUEsportBackend/actions/runs/37728405540>

การรัน Worker เต็มชุดใน Windows รอบแรกไม่ครบเพราะ pool เริ่มไม่ทันและมี assertion ของ test ใหม่ 3 จุดที่เขียนผิด แก้ assertion ให้ตรง validation 422 และให้ helper ไม่เขียน Origin ทับ แล้ว auth tests ผ่าน 30/30 ในเครื่อง; CI ตรวจเต็ม source สุดท้ายผ่าน 300/300 ไม่ใช้ผลรอบแรกเป็นหลักฐานว่าผ่านครบ

ชุด UI live 552/552 และ demo 174/174 เป็นผลก่อนปรับวิธีตรวจรหัสและ alias รอบนี้ ไม่ได้อ้างว่าเป็นผลของ source ล่าสุด

## ตรวจบน production จริง

สร้างบัญชีทดสอบชั่วคราวด้วยข้อมูลสมมติใน D1 แล้วลบหลังตรวจ ไม่สร้างหรือแก้ไฟล์ Google:

- หน้า login และ API session เป็นรุ่นใหม่ Google login ยังตั้งค่าอยู่
- เข้าสู่ระบบด้วย `u` และตัวเลขล้วนได้ เป็นสมาชิกคนเดิม
- เปลี่ยนรหัสชั่วคราวครั้งแรกสำเร็จ session เก่าใช้ไม่ได้ รหัสใหม่ใช้ได้
- API ข้อมูลตนเองและกิจกรรมทำงาน สมาชิกเข้าถึง API ทีมงานไม่ได้
- หน้า login ที่ publish ใช้ browser Web Worker จริง เข้าหน้าสมาชิกได้ที่ 390×844 ไม่มี page error หรือแนวนอนล้น
- ลบบัญชี/session และ audit ของบัญชีทดสอบแล้ว ยืนยันไม่เหลือแถวสมาชิกทดสอบ

ตัวตรวจ production ครั้งแรกอ่านหัวข้อทันทีหลัง URL เปลี่ยน ก่อนหน้าโหลดเสร็จ จึงรายงานไม่ผ่าน แก้เฉพาะตัวตรวจให้รอหัวข้อ แล้วผ่าน ไม่แก้โค้ดเว็บระหว่างสองรอบ

## สิ่งที่ผู้ดูแลต้องทำ

1. เข้าเว็บด้วย Google ของชมรม ไปที่สมาชิก กรอกรหัสนักศึกษาและตั้งรหัสผ่านชั่วคราวให้บัญชีที่ต้องใช้ สมาชิกเปลี่ยนรหัสเองเมื่อเข้าครั้งแรก
2. ไปที่ไฟล์ชมรม กด “เปิดใช้คลังไฟล์ Google” และให้สิทธิ์ `drive.readonly` ณ เวลาตรวจ production บัญชีชมรมเชื่อมอยู่ แต่ยังไม่ได้รับ scope นี้ คลังจึงยังไม่เปิด
3. หลัง consent ทดลองรายการและ preview ไฟล์จริง รวมการแก้ต้นฉบับใน Google แล้วโหลดล่าสุดในเว็บ

ยังไม่ได้ตรวจข้อมูล/preview Google จริงหลัง scope ใหม่, Google Picker จริงใน Brave, มือถือจริง หรือ screen reader ทั้งระบบ สมาชิกดูตัวอย่างผ่าน server ได้เมื่อเปิดคลังแล้ว ส่วนปุ่มเปิดต้นฉบับขึ้นกับสิทธิ์ Google ของบัญชีที่เปิด

## หลักฐานในเครื่อง

ภาพอยู่ screenshots/ (ไม่รวมใน Git) เช่น member-login-390, member-home-390, member-first-password-390 และ admin-set-password-390 ข้อมูลทั้งหมดในภาพทดสอบเป็นข้อมูลสมมติ

ผลรันในโฟลเดอร์งาน Codex: relief-member-ui.log, relief-auth-check.log, relief-build-production.log, relief-production-dry-run.log, relief-production-deploy.log และ production-member-check.json สำเนาฐานข้อมูล production อยู่นอก Git และไม่เผยแพร่
