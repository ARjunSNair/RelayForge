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

/** A signing secret sealed under the data-encryption key named by `keyId`. */
export interface SealedSecret {
  keyId: string;
  ciphertext: Buffer;
}

export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Data-encryption keys by id. New secrets are sealed with the primary key;
 * previous keys stay available for decryption until every row sealed with
 * them has been rewrapped (see `pnpm admin:rewrap-secrets`).
 */
export class SecretKeyring {
  readonly #boxes = new Map<string, SecretBox>();

  constructor(
    readonly primaryKeyId: string,
    primaryKey: string,
    previous: ReadonlyArray<{ id: string; key: string }> = [],
  ) {
    for (const { id, key } of [{ id: primaryKeyId, key: primaryKey }, ...previous]) {
      if (!KEY_ID_PATTERN.test(id)) throw new Error(`Invalid encryption key id "${id}"`);
      if (this.#boxes.has(id)) throw new Error(`Duplicate encryption key id "${id}"`);
      this.#boxes.set(id, new SecretBox(key));
    }
  }

  /** Parse `id:base64key,id:base64key` (the SIGNING_SECRET_PREVIOUS_KEYS format). */
  static parsePrevious(spec: string | undefined): Array<{ id: string; key: string }> {
    if (!spec?.trim()) return [];
    return spec.split(',').map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0) throw new Error('Previous keys must be formatted as id:base64key');
      return { id: entry.slice(0, separator).trim(), key: entry.slice(separator + 1).trim() };
    });
  }

  encrypt(plaintext: string): SealedSecret {
    return {
      keyId: this.primaryKeyId,
      ciphertext: this.#boxes.get(this.primaryKeyId)!.encrypt(plaintext),
    };
  }

  decrypt(sealed: SealedSecret): string {
    const box = this.#boxes.get(sealed.keyId);
    if (!box) throw new Error(`Unknown encryption key id "${sealed.keyId}"`);
    return box.decrypt(sealed.ciphertext);
  }

  has(keyId: string): boolean {
    return this.#boxes.has(keyId);
  }
}
