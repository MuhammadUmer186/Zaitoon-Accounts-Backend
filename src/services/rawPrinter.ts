import net from 'node:net'

export type RawDelivery = 'network_sent' | 'queued' | 'uncertain'
// Shared by the branch worker and the standalone agent. This reports a transport
// result, never a claim that paper printed. After any write, retry needs review.
export function sendRawPrinter(target: { host: string; port: number }, bytes: Buffer, timeout = 15000): Promise<RawDelivery> {
  if (!bytes.length || bytes.length > 16384) return Promise.reject(new Error('Invalid slip length'))
  return new Promise(resolve => {
    let wrote = false, done = false
    const socket = net.createConnection({ host: target.host, port: target.port })
    const finish = (state: RawDelivery) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(state) }
    const timer = setTimeout(() => finish(wrote ? 'uncertain' : 'queued'), timeout)
    socket.once('connect', () => {
      wrote = true
      socket.end(bytes, () => { /* wait for TCP peer close, not only local buffering */ })
    })
    socket.on('data', () => {})
    socket.once('error', () => finish(wrote ? 'uncertain' : 'queued'))
    socket.once('end', () => finish(wrote && socket.writableFinished ? 'network_sent' : wrote ? 'uncertain' : 'queued'))
    socket.once('close', hadError => finish(!hadError && wrote && socket.writableFinished ? 'network_sent' : wrote ? 'uncertain' : 'queued'))
  })
}
