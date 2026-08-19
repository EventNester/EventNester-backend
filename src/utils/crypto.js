import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// ── QR token encryption at rest ───────────────────────────────────────────────
//
// The raw QR token is never stored in plaintext. It is encrypted with
// AES-256-GCM before persistence so the scan token can later be recovered for
// authorized callers (event owner / ADMIN / ticket holder) when rebuilding
// gate-scannable PDFs. The 32-byte key is derived from JWT_SECRET via HMAC
// domain separation, so no extra environment variable is required and a leaked
// DB alone does not expose the tokens.

const QR_TOKEN_KEY_LABEL = "qpass:qr-token:encryption:v1";
const QR_TOKEN_ALGORITHM = "aes-256-gcm";
const QR_TOKEN_IV_LENGTH = 12;
const QR_TOKEN_AUTH_TAG_LENGTH = 16;

function getQrTokenKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "test") {
      return createHmac("sha256", "qpass-test-only-key").update(QR_TOKEN_KEY_LABEL).digest();
    }
    throw new Error("JWT_SECRET is required to encrypt QR tokens");
  }
  return createHmac("sha256", secret).update(QR_TOKEN_KEY_LABEL).digest();
}

/**
 * Encrypt a raw QR token for storage at rest.
 * @param {string} token - Raw opaque QR token (64-char hex)
 * @returns {string} URL-safe base64 payload of `iv.ciphertext.authTag`
 */
export function encryptQrToken(token) {
  const iv = randomBytes(QR_TOKEN_IV_LENGTH);
  const cipher = createCipheriv(QR_TOKEN_ALGORITHM, getQrTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("base64url");
}

/**
 * Decrypt a raw QR token stored via {@link encryptQrToken}.
 * @param {string} payload - URL-safe base64 payload from `tokenCipher`
 * @returns {string} The raw opaque QR token
 * @throws {Error} If the payload is malformed or the auth tag fails (wrong key / tampered data)
 */
export function decryptQrToken(payload) {
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, QR_TOKEN_IV_LENGTH);
  const authTag = buf.subarray(buf.length - QR_TOKEN_AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(QR_TOKEN_IV_LENGTH, buf.length - QR_TOKEN_AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(QR_TOKEN_ALGORITHM, getQrTokenKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
