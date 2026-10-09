export const CONTACT_PLATFORMS = {
  discord: 'Discord',
  instagram: 'Instagram',
  facebook: 'Facebook',
  line: 'LINE',
  phone: 'เบอร์โทรศัพท์',
  twitter: 'Twitter / X',
  bluesky: 'Bluesky',
  reddit: 'Reddit',
  whatsapp: 'WhatsApp',
} as const
export type ContactPlatform = keyof typeof CONTACT_PLATFORMS
export interface ContactChannel {
  platform: ContactPlatform
  value: string
}
