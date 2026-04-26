/**
 * AES-256-GCM encryption for SSH credentials at rest.
 * Requires CLOUDCLI_VAULT_KEY: base64-encoded 32 bytes (preferred) or 64-char hex.
 *
 * @module server/utils/ssh-vault
 */

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function decodeVaultKey() {
  const raw = process.env.CLOUDCLI_VAULT_KEY?.trim();
  if (!raw) {
    return null;
  }
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) {
      return buf;
    }
  } catch {
    return null;
  }
  return null;
}

/** @returns {boolean} */
export function isVaultConfigured() {
  const k = decodeVaultKey();
  return Boolean(k && k.length === 32);
}

function requireKey() {
  const key = decodeVaultKey();
  if (!key || key.length !== 32) {
    const err = new Error(
      'CLOUDCLI_VAULT_KEY is not set or invalid. Set a 32-byte key as base64 (e.g. node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))") or 64 hex chars.',
    );
    err.code = 'VAULT_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

/**
 * @param {string} plaintextUtf8
 * @returns {string} base64(iv + tag + ciphertext)
 */
export function encryptSecret(plaintextUtf8) {
  const key = requireKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintextUtf8, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * @param {string} blobB64 from encryptSecret
 * @returns {string} utf8 plaintext
 */
export function decryptSecret(blobB64) {
  const key = requireKey();
  const buf = Buffer.from(blobB64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Invalid encrypted payload');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
