import { EventEmitter } from 'events'
import { Request, Response } from 'express'

// Real-time updates for the ordering module, pushed to browsers over
// Server-Sent Events. Every change (new order, item status, order closed,
// dish out of stock, review, menu/table edit) is published here and fanned
// out to the open staff screens of that organization and to the guest
// screens of the affected table — so nothing needs a manual refresh.
//
// In-memory and single-process (one backend container). Screens also
// re-sync whenever their stream reconnects, so a restart loses nothing.

export type LiveTopic = 'order' | 'availability' | 'menu' | 'review' | 'table' | 'sale' | 'settings' | 'hr'

export interface LiveEvent {
  topic: LiveTopic
  action: string // e.g. created, items_added, item_status, completed, cancelled
  organizationId: string
  branchId?: string | null
  tableId?: string | null
  orderId?: string | null
  orderNo?: number | null
  tableName?: string | null
  // guest_cancelled: the dishes the kitchen had (already sent to it) — the
  // printer device prints a cancellation slip for exactly these
  itemIds?: string[]
}

const bus = new EventEmitter()
bus.setMaxListeners(0)

export function publish(event: LiveEvent) {
  bus.emit('event', { ...event, at: new Date().toISOString() })
}

const HEARTBEAT_MS = 15_000

// Opens an SSE response and forwards the events `accept` lets through.
// A comment line every 15 s keeps proxies (Next.js, Traefik) from closing
// an idle connection.
export function openStream(req: Request, res: Response, accept: (e: LiveEvent) => Record<string, unknown> | null) {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  // no-transform: stops compression middleware from buffering the stream
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  req.socket.setTimeout(0)
  req.socket.setNoDelay(true)

  const write = (chunk: string) => { if (!res.writableEnded) res.write(chunk) }
  write('retry: 3000\n')
  write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)

  const onEvent = (e: LiveEvent) => {
    const payload = accept(e)
    if (payload) write(`event: ${e.topic}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  bus.on('event', onEvent)
  const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)

  const close = () => {
    clearInterval(heartbeat)
    bus.off('event', onEvent)
  }
  req.on('close', close)
  res.on('close', close)
}
