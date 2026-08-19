import { randomBytes } from "crypto";
import QRCode from "qrcode";
import prisma from "../../database/index.js";
import { hashToken, encryptQrToken, decryptQrToken } from "../../utils/crypto.js";
import { NotFoundError } from "../../utils/error.js";
import { systemMessages, constants, logger } from "../../config/index.js";

const msg = systemMessages.ERROR;
const QR_MIN_SIZE = 200;
const QR_MAX_SIZE = constants.QR.MAX_SIZE;
const REISSUE_WINDOW_HOURS = 24;

/**
 * QR Token
 *
 * Tokens are opaque 64-char hex strings generated via `crypto.randomBytes(32)`.
 * Only the SHA-256 hash is stored in the database, plus an AES-256-GCM
 * encryption of the raw token (`tokenCipher`) so the scan token can be
 * recovered later for authorized callers. Expiration is enforced against the
 * `QrToken.expiresAt` column (set to `event.endTime + 24h` at issuance time).
 * The raw token is delivered to the attendee and never stored in plaintext.
 *
 * @typedef {Object} QrTokenRecord
 * @property {string} id
 * @property {string} registrationId
 * @property {string} tokenHash - SHA-256 hex digest of the raw token
 * @property {string|null} tokenCipher - AES-256-GCM ciphertext of the raw token
 * @property {Date} issuedAt
 * @property {Date} expiresAt - event.endTime + 24h
 * @property {Date|null} revokedAt
 * @property {number} scanCount
 */

class QrService {
  /**
   * Generate an opaque QR token for a registration.
   *
   * 1. Produce a random 64-char hex token.
   * 2. SHA-256 hash it and store the hash in QrToken.
   * 3. Return the raw token (delivered to attendee, never stored).
   *
   * @param {string} registrationId - The registration this token belongs to
   * @param {Date} expiresAt - Absolute expiration datetime (typically event.endTime + 24h)
   * @returns {Promise<string>} The raw hex token to deliver to the attendee
   * @throws {Error} If a token already exists for this registration
   */
  async generateToken(registrationId, expiresAt) {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const tokenCipher = encryptQrToken(rawToken);

    try {
      await prisma.qrToken.create({
        data: {
          registrationId,
          tokenHash,
          tokenCipher,
          expiresAt,
        },
      });
    } catch (err) {
      if (err.code === 'P2002') {
        throw new Error(msg.TICKET.ALREADY_EXISTS, { cause: err });
      }
      throw err;
    }

    return rawToken;
  }

  /**
   * Recover the raw QR token for a stored QrToken record.
   *
   * Tokens issued after the `tokenCipher` column shipped are decrypted and
   * returned as-is. Legacy tokens (issued before encryption, `tokenCipher`
   * null) cannot be recovered, so they are rotated once: a new random token
   * replaces the stored hash/cipher and the raw value is returned. Rotation is
   * skipped for revoked tokens — a checked-in pass must never gain a fresh
   * scanable token — in which case `null` is returned.
   *
   * @param {Object} qrToken - QrToken record (needs `id`, `registrationId`, `tokenCipher`, `revokedAt`)
   * @param {Object} [event] - Event record whose `endTime` drives the new expiry on rotation
   * @returns {Promise<string|null>} The raw scan token, or null if unavailable
   */
  async recoverRawToken(qrToken, event) {
    if (!qrToken) {
      return null;
    }

    if (qrToken.tokenCipher) {
      try {
        return decryptQrToken(qrToken.tokenCipher);
      } catch (err) {
        logger.warn(
          { err: err.message, registrationId: qrToken.registrationId },
          'QR token cipher could not be decrypted; rotating token'
        );
      }
    }

    if (qrToken?.revokedAt) {
      return null;
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const tokenCipher = encryptQrToken(rawToken);
    const expiresAt = event?.endTime
      ? new Date(new Date(event.endTime).getTime() + REISSUE_WINDOW_HOURS * 60 * 60 * 1000)
      : new Date(Date.now() + REISSUE_WINDOW_HOURS * 60 * 60 * 1000);

    await prisma.qrToken.update({
      where: { id: qrToken.id },
      data: { tokenHash, tokenCipher, expiresAt },
    });

    return rawToken;
  }

  /**
   * Validate a scanned QR token string.
   *
   * 1. Hash the raw token with SHA-256.
   * 2. Look up the QrToken record by hash.
   * 3. Check expiration (expiresAt must be in the future).
   * 4. Check revocation (revokedAt must be null).
   * 5. Return the registration data if valid.
   *
   * @param {string} token - The raw token string scanned from the QR code
   * @returns {Promise<Object>} The QrToken record with its registration
   * @throws {NotFoundError} If the token hash is not found
   * @throws {Error} If the token has expired
   * @throws {Error} If the token has been revoked
   */
  async validateToken(token) {
    const tokenHash = hashToken(token);

    const qrToken = await prisma.qrToken.findUnique({
      where: { tokenHash },
      include: { registration: true },
    });

    if (!qrToken) {
      throw new NotFoundError(msg.TICKET.INVALID_QR);
    }

    if (new Date(qrToken.expiresAt) < new Date()) {
      throw new Error(msg.TICKET.EXPIRED);
    }

    if (qrToken.revokedAt) {
      throw new Error(msg.TICKET.REVOKED);
    }

    return qrToken;
  }

  /**
   * Generate a QR code PNG buffer from a raw token string.
   *
   * Width is clamped to a minimum of 200px to ensure scannability
   * on small displays. Defaults to constants.QR.SIZE (300px).
   *
   * @param {string} token - The raw hex token to encode in the QR code
   * @param {Object} [options]
   * @param {number} [options.width] - Image width in px (default: constants.QR.SIZE)
   * @param {number} [options.margin] - Quiet zone in modules (default: 2)
   * @param {string} [options.errorCorrectionLevel] - L/M/Q/H (default: "M")
   * @returns {Promise<Buffer>} PNG image buffer
   */
  async createQrImage(token, options = {}) {
    const width = Math.min(Math.max(options.width ?? constants.QR.SIZE, QR_MIN_SIZE), QR_MAX_SIZE);
    return QRCode.toBuffer(token, {
      width,
      margin: options.margin ?? 2,
      errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
    });
  }
}

export const qrService = new QrService();
