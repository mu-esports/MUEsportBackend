import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// โหมดปกติ: หน้าเว็บ + Worker (API, เข้าสู่ระบบ, D1) รันด้วยกันผ่าน Cloudflare Vite plugin
// โหมด demo (`vite --mode demo`): หน้าเว็บอย่างเดียวกับข้อมูลตัวอย่างในเบราว์เซอร์ ไม่มี Worker
// MU_STATE_DIR: ที่เก็บ D1 local แยกสำหรับชุดตรวจ UI เพื่อไม่แตะข้อมูลพัฒนาในเครื่อง
const stateDir = process.env.MU_STATE_DIR

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'demo' ? [] : [cloudflare(stateDir ? { persistState: { path: stateDir } } : {})])],
  server: { port: mode === 'demo' ? 5174 : 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
}))
