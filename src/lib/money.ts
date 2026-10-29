const PRICE_MAX_CENTS = 200_000
const VENUE_MAX_CENTS = 10_000_000

export function parseReaisToCents(
  input: string,
  options?: { allowZero?: boolean; maxCents?: number },
): number | null {
  const maxCents = options?.maxCents ?? PRICE_MAX_CENTS
  let cleaned = input.trim().replace(/\s/g, '').replace(/^R\$/i, '')
  if (!cleaned) return null
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.')
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.')
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, frac = ''] = cleaned.split('.')
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null
  if (cents > maxCents) return null
  if (cents < 1 && !(options?.allowZero && cents === 0)) return null
  return cents
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}R$ ${grouped},${frac}`
}

export function normalizeAccessCode(value: string): string {
  return value.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 20)
}

export function formatAccessCode(value: string): string {
  return normalizeAccessCode(value).replace(/(.{4})/g, '$1 ').trim()
}

export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function serviceShareCents(totalCents: number): number {
  if (!Number.isInteger(totalCents) || totalCents <= 0) return 0
  return Math.trunc((totalCents + 5) / 10)
}

export function joinUrl(code: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const url = new URL(base, window.location.origin)
  url.hash = `/j/${code}`
  return url.href
}

export function whatsAppShareUrl(name: string, code: string): string {
  const text = `Mesa ${name} no Chope Justo.\nEntra por este link, cria tua conta e já cai nesta mesa:\n${joinUrl(code)}`
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}

export const VENUE_MAX = VENUE_MAX_CENTS
