import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("qrcode", () => ({
  default: {
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("mock-png")),
  },
}));

vi.mock("../../../database/index.js", () => ({
  default: {
    qrToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { qrService } from "../qr.service.js";
import prisma from "../../../database/index.js";
import QRCode from "qrcode";
import { hashToken } from "../../../utils/crypto.js";

describe("QrService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateToken", () => {
    it("should generate a 64-char hex token and store the hash", async () => {
      prisma.qrToken.findUnique.mockResolvedValue(null);
      prisma.qrToken.create.mockResolvedValue({});

      const expiresAt = new Date("2026-08-01T00:00:00Z");
      const token = await qrService.generateToken("reg-1", expiresAt);

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(prisma.qrToken.create).toHaveBeenCalledWith({
        data: {
          registrationId: "reg-1",
          tokenHash: expect.any(String),
          tokenCipher: expect.any(String),
          expiresAt,
        },
      });
    });

    it("should throw if a token already exists for the registration", async () => {
      prisma.qrToken.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        qrService.generateToken("reg-1", new Date())
      ).rejects.toThrow("QR token already exists for this registration");
    });

    it("should not call create multiple times on duplicate", async () => {
      prisma.qrToken.create.mockRejectedValue({ code: 'P2002' });

      await qrService.generateToken("reg-1", new Date()).catch(() => {});
      expect(prisma.qrToken.create).toHaveBeenCalledTimes(1);
    });

    it("should rethrow non-P2002 errors", async () => {
      prisma.qrToken.create.mockRejectedValue(new Error("DB timeout"));

      await expect(
        qrService.generateToken("reg-1", new Date())
      ).rejects.toThrow("DB timeout");
    });
  });

  describe("recoverRawToken", () => {
    const event = { endTime: new Date("2026-08-10T00:00:00Z") };

    it("should return the null when no record exists", async () => {
      const token = await qrService.recoverRawToken(null, event);
      expect(token).toBeNull();
    });

    it("should decrypt and return the stored raw token when a cipher exists", async () => {
      const rawToken = "a".repeat(64);
      const { encryptQrToken } = await import("../../../utils/crypto.js");
      const qrToken = {
        id: "qr-1",
        registrationId: "reg-1",
        tokenHash: hashToken(rawToken),
        tokenCipher: encryptQrToken(rawToken),
        revokedAt: null,
      };

      const token = await qrService.recoverRawToken(qrToken, event);
      expect(token).toBe(rawToken);
      expect(prisma.qrToken.updateMany).not.toHaveBeenCalled();
    });

    it("should rotate a token whose cipher does not match the stored hash", async () => {
      const { encryptQrToken } = await import("../../../utils/crypto.js");
      const badCipher = encryptQrToken("a".repeat(64));
      const qrToken = {
        id: "qr-1",
        registrationId: "reg-1",
        tokenHash: hashToken("b".repeat(64)),
        tokenCipher: badCipher,
        revokedAt: null,
      };
      prisma.qrToken.updateMany.mockResolvedValue({ count: 1 });

      const token = await qrService.recoverRawToken(qrToken, event);

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(prisma.qrToken.updateMany).toHaveBeenCalledWith({
        where: { id: "qr-1", tokenCipher: badCipher, revokedAt: null },
        data: {
          tokenHash: hashToken(token),
          tokenCipher: expect.any(String),
          expiresAt: expect.any(Date),
        },
      });
    });

    it("should rotate a legacy token (no cipher) and persist the new hash and cipher", async () => {
      const qrToken = {
        id: "qr-1",
        registrationId: "reg-1",
        tokenCipher: null,
        revokedAt: null,
      };
      prisma.qrToken.updateMany.mockResolvedValue({ count: 1 });

      const token = await qrService.recoverRawToken(qrToken, event);

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(prisma.qrToken.updateMany).toHaveBeenCalledWith({
        where: { id: "qr-1", tokenCipher: null, revokedAt: null },
        data: {
          tokenHash: hashToken(token),
          tokenCipher: expect.any(String),
          expiresAt: new Date("2026-08-11T00:00:00Z"),
        },
      });
    });

    it("should not rotate a revoked legacy token and return null", async () => {
      const qrToken = {
        id: "qr-1",
        registrationId: "reg-1",
        tokenCipher: null,
        revokedAt: new Date(),
      };

      const token = await qrService.recoverRawToken(qrToken, event);
      expect(token).toBeNull();
      expect(prisma.qrToken.updateMany).not.toHaveBeenCalled();
    });

    it("should return the winning token when a concurrent rotation wins the race", async () => {
      const { encryptQrToken } = await import("../../../utils/crypto.js");
      const winningRawToken = "c".repeat(64);
      prisma.qrToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.qrToken.findUnique.mockResolvedValue({
        id: "qr-1",
        registrationId: "reg-1",
        tokenHash: hashToken(winningRawToken),
        tokenCipher: encryptQrToken(winningRawToken),
        revokedAt: null,
      });

      const token = await qrService.recoverRawToken(
        { id: "qr-1", registrationId: "reg-1", tokenCipher: null, revokedAt: null },
        event
      );

      expect(token).toBe(winningRawToken);
      expect(prisma.qrToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.qrToken.findUnique).toHaveBeenCalledWith({ where: { id: "qr-1" } });
    });

    it("should return null when the winning token was revoked during the race", async () => {
      prisma.qrToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.qrToken.findUnique.mockResolvedValue({
        id: "qr-1",
        registrationId: "reg-1",
        tokenCipher: null,
        revokedAt: new Date(),
      });

      const token = await qrService.recoverRawToken(
        { id: "qr-1", registrationId: "reg-1", tokenCipher: null, revokedAt: null },
        event
      );

      expect(token).toBeNull();
    });
  });

  describe("validateToken", () => {
    it("should return the token record with registration when valid", async () => {
      const mockRecord = {
        id: "qr-1",
        tokenHash: "abc",
        expiresAt: new Date("2099-01-01"),
        revokedAt: null,
        registration: { id: "reg-1", attendeeName: "Ada" },
      };
      prisma.qrToken.findUnique.mockResolvedValue(mockRecord);

      const result = await qrService.validateToken("some-token");
      expect(result).toEqual(mockRecord);
    });

    it("should throw NotFoundError for an unknown token", async () => {
      prisma.qrToken.findUnique.mockResolvedValue(null);

      await expect(qrService.validateToken("unknown")).rejects.toThrow("Invalid QR token");
    });

    it("should throw if the token has expired", async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        id: "qr-1",
        expiresAt: new Date("2020-01-01"),
        revokedAt: null,
        registration: {},
      });

      await expect(qrService.validateToken("expired")).rejects.toThrow("QR token has expired");
    });

    it("should throw if the token has been revoked", async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        id: "qr-1",
        expiresAt: new Date("2099-01-01"),
        revokedAt: new Date(),
        registration: {},
      });

      await expect(qrService.validateToken("revoked")).rejects.toThrow("QR token has been revoked");
    });
  });

  describe("createQrImage", () => {
    it("should return a PNG buffer for a valid token", async () => {
      const buf = await qrService.createQrImage("abc123");
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.toString()).toBe("mock-png");
      expect(QRCode.toBuffer).toHaveBeenCalledWith("abc123", {
        width: 300,
        margin: 2,
        errorCorrectionLevel: "M",
      });
    });

    it("should enforce minimum width of 200px", async () => {
      await qrService.createQrImage("abc123", { width: 100 });
      expect(QRCode.toBuffer).toHaveBeenCalledWith("abc123", expect.objectContaining({ width: 200 }));
    });

    it("should accept custom width and margin", async () => {
      await qrService.createQrImage("abc123", { width: 400, margin: 4 });
      expect(QRCode.toBuffer).toHaveBeenCalledWith("abc123", {
        width: 400,
        margin: 4,
        errorCorrectionLevel: "M",
      });
    });

    it("should clamp width to the maximum allowed size", async () => {
      await qrService.createQrImage("abc123", { width: 5000 });
      expect(QRCode.toBuffer).toHaveBeenCalledWith(
        "abc123",
        expect.objectContaining({ width: 1000 })
      );
    });

    it("should pass through a custom error correction level", async () => {
      await qrService.createQrImage("abc123", { errorCorrectionLevel: "H" });
      expect(QRCode.toBuffer).toHaveBeenCalledWith("abc123", {
        width: 300,
        margin: 2,
        errorCorrectionLevel: "H",
      });
    });
  });
});
