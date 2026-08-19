-- Add encrypted raw-token storage to QrToken so the scan token can be
-- recovered and returned to authorized callers (event owner / ADMIN / ticket
-- holder) for gate-scannable PDFs. NULL for legacy rows issued before this
-- change; those tokens are rotated on first authorized read.
ALTER TABLE "qr_tokens" ADD COLUMN "token_cipher" TEXT;