export type OutboxItem = {
  idempotencyKey: string
  roundId: string
  consumerId: string
  quantity: number
  origin: string
  createdAt: string
}

const KEY = 'chope-justo-outbox-v1'

function readAll(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as OutboxItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(items: OutboxItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export function outboxFor(roundId: string): OutboxItem[] {
  return readAll().filter((item) => item.roundId === roundId)
}

export function enqueueOutbox(item: OutboxItem) {
  const items = readAll().filter((current) => current.idempotencyKey !== item.idempotencyKey)
  items.push(item)
  writeAll(items)
}

export function removeOutbox(idempotencyKey: string) {
  writeAll(readAll().filter((item) => item.idempotencyKey !== idempotencyKey))
}

export function isOfflineError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const message = error instanceof Error ? error.message : ''
  return /failed to fetch|network|timeout|load failed|conex[aã]o/i.test(message)
}
