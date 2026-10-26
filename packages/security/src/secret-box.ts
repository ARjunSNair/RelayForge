import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Authenticated encryption for endpoint signing secrets at rest.
 * Layout: iv (12) || ciphertext || auth tag (16).
 *
 * The data-encryption key comes from configuration; in Azure it is sourced
 * from Key Vault via managed identity rather than embedded in app settings.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.#key = key;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv, { authTagLength: TAG_BYTES });
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }

  decrypt(sealed: Buffer): string {
    if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext too short');
    const iv = sealed.subarray(0, IV_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const body = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.#key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}
