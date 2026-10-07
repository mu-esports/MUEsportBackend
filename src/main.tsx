import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import '@fontsource/ibm-plex-sans-thai/400.css'
import '@fontsource/ibm-plex-sans-thai/500.css'
import '@fontsource/ibm-plex-sans-thai/600.css'
import './styles.css'
import './library/library.css'
import './member/member.css'
import { router } from './App'
import { applyTheme, storedTheme } from './theme'

// ตั้งธีมก่อนแสดงผลครั้งแรก เพื่อไม่ให้หน้ากะพริบเป็นธีมสว่างก่อน
applyTheme(storedTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
