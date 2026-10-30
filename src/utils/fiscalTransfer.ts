import crypto from 'crypto'

// Moves fiscal device secrets from the cloud to one branch PC. The PC creates a
// one-time RSA key pair at installation and sends only the public key; the
// cloud wraps each secret for that key, so the installation package never holds
// a readable key or a value the cloud's own sealing key could open elsewhere.
// Format: v1.<RSA-OAEP(SHA-256) wrapped AES key>.<iv>.<tag>.<AES-256-GCM data>
export function wrapForPc(plain: string, publicKeyPem: string): string {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const wrappedKey = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
  return ['v1', wrappedKey, iv, cipher.getAuthTag(), data].map(p => typeof p === 'string' ? p : p.toString('base64')).join('.')
}

export function unwrapOnPc(wrapped: string, privateKeyPem: string): string {
  const [version, wrappedKey, iv, tag, data] = wrapped.split('.')
  if (version !== 'v1' || !data) throw new Error('Unsupported fiscal secret format')
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(wrappedKey, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

export function assertTransferPublicKey(pem: string) {
  const key = crypto.createPublicKey(pem)
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) throw new Error('A 3072-bit or larger RSA transfer key is required')
}
