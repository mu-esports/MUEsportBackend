import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// โหมดปกติ: หน้าเว็บ + Worker (API, เข้าสู่ระบบ, D1) รันด้วยกันผ่าน Cloudflare Vite plugin
// โหมด demo (`vite --mode demo`): หน้าเว็บอย่างเดียวกับข้อมูลตัวอย่างในเบราว์เซอร์ ไม่มี Worker
// MU_STATE_DIR: ที่เก็บ D1 local แยกสำหรับชุดตรวจ UI เพื่อไม่แตะข้อมูลพัฒนาในเครื่อง
const stateDir = process.env.MU_STATE_DIR

/**
 * ตัวแสดง PDF (PDF.js) ต้องใช้ไฟล์ประกอบตอนเปิดไฟล์บางชนิด: ตารางอักขระ (cmaps) ฟอนต์มาตรฐาน และตัวถอดรหัสภาพสแกน (wasm)
 * คัดลอกจากแพ็กเกจมาไว้ใน public/pdfjs (ไม่อยู่ใน Git) ทุกครั้งที่รุ่นของแพ็กเกจเปลี่ยน เพื่อให้เสิร์ฟจากเว็บของเราเอง ไม่ดึงจากเว็บอื่น
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'mu-pdfjs-assets',
    buildStart() {
      const packageFile = createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
      const source = dirname(packageFile)
      const version = (JSON.parse(readFileSync(packageFile, 'utf8')) as { version: string }).version
      const target = join(process.cwd(), 'public', 'pdfjs')
      const marker = join(target, 'version.txt')
      if (existsSync(marker) && readFileSync(marker, 'utf8') === version) return
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      for (const folder of ['cmaps', 'standard_fonts', 'wasm']) cpSync(join(source, folder), join(target, folder), { recursive: true })
      writeFileSync(marker, version)
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'demo' ? [] : [pdfjsAssets(), cloudflare(stateDir ? { persistState: { path: stateDir } } : {})])],
  server: { port: mode === 'demo' ? 5174 : 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
}))
