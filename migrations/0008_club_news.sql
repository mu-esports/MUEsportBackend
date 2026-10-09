-- ข่าวกลางสำหรับหลังบ้านและหน้าสมาชิก ไม่ผูกสิทธิ์ Instagram หรือแก้ repo หน้าบ้าน
CREATE TABLE club_news (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'ประกาศ',
  published_date TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  instagram_url TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX club_news_published ON club_news(status, published_date DESC);

-- นำเข้าครั้งเดียวจากข่าวสาธารณะสองรายการของหน้าเว็บชมรม ตรวจจาก source วันที่ 9 ต.ค. 2569
-- เป็นสำเนาที่ทีมงานแก้ได้ ไม่ใช่ Instagram sync และไม่แปลงวันรับสมัครเป็นกำหนดการโดยเดาเวลา
INSERT INTO club_news (id,title,summary,body,category,published_date,image_url,instagram_url,source_url,status,created_by,updated_by,created_at,updated_at)
VALUES (
  'club-news-valorant-20261007',
  'รับสมัครทีมตัวแทนชมรม VALORANT เปิดรับถึง 14 ตุลาคม',
  'ชมรมเปิดรับสมัครทีมตัวแทน VALORANT เพื่อลงแข่งขันในรายการต่าง ๆ ที่จะมีมา สมัครได้ตั้งแต่วันนี้ถึง 14 ตุลาคม 2569 โดยสแกน QR Code บนโปสเตอร์',
  'รับสมัครทีมตัวแทน VALORANT เพื่อเข้าร่วมรายการการแข่งขันของเกม Valorant ในรายการต่าง ๆ ที่จะมีมา

เปิดรับสมัครแล้ว วันนี้ - 14 ตุลาคม 2569
แสกน QR Code บนโปสเตอร์เพื่อสมัครได้เลย

คุณสมบัติ
- อายุมากกว่า 15 ปี
- เป็นนักศึกษามหาวิทยาลัยมหิดลจริง
- สามารถเดินทางไปเข้าร่วมการแข่งขันได้ หากมีการแข่งขันออฟไลน์',
  'รับสมัคร','2026-10-07',
  'https://mu-esports-website.muesport2567.workers.dev/news/valorant-recruit.jpg',
  'https://www.instagram.com/p/DeMyB6HzLvp/',
  'https://mu-esports-website.muesport2567.workers.dev/#news',
  'published','public-site-import','public-site-import','2026-10-09T00:00:00Z','2026-10-09T00:00:00Z'
), (
  'club-news-rov-20260921',
  'RoV ทีมหญิงขาดป่า! รับสมัครนักกีฬาตำแหน่ง Jungle',
  'รับสมัครนักกีฬาอีสปอร์ตเพิ่มเติมในประเภท Arena of Valor (RoV) ทีมหญิง ตำแหน่ง Jungle ตั้งแต่วันนี้ถึง 30 กันยายน 2569',
  'RoV หญิงขาดป่า! รับสมัครนักกีฬาอีสปอร์ตเพิ่มเติม ในประเภท Arena of Valor (RoV) ทีมหญิง ตำแหน่ง Jungle

รับสมัครวันนี้ - 30 กันยายน 2569
วัน เวลา คัดเลือกจะแจ้งให้ทราบภายหลัง
สแกน QR Code บนโปสเตอร์แล้วกรอกฟอร์มได้เลย

คุณสมบัติของผู้สมัคร
- เป็นนักศึกษาของมหาวิทยาลัยมหิดล
- เพศหญิง อายุไม่เกิน 28 ปี
- อดีตแรงค์ Conqueror ขึ้นไป
- รู้มาโครพื้นฐาน เล่นฮีโร่ได้หลากหลาย
- มีดิสคอร์ดและสามารถคอลเกมได้
- มีเวลาว่างซ้อมกับทีม
- มีความประพฤติดี
- ผลการเรียนสะสมอยู่ในเกณฑ์ไม่เสี่ยงโดนรีไทร์ (พิจารณารายบุคคล)
- ไม่อยู่ในระหว่างถูกลงโทษตัดสิทธิ์การแข่งขันจากกีฬามหาวิทยาลัยฯ สมาคมอีสปอร์ตฯ หรือ กกท.',
  'รับสมัคร','2026-09-21',
  'https://mu-esports-website.muesport2567.workers.dev/news/rov-women-jungle.jpg',
  'https://www.instagram.com/p/Ddic9Wszy2k/',
  'https://mu-esports-website.muesport2567.workers.dev/#news',
  'published','public-site-import','public-site-import','2026-10-09T00:00:00Z','2026-10-09T00:00:00Z'
);
