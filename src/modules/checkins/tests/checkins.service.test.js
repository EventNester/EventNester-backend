import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { scanQr, getCheckins, undoCheckin, getCheckinStatistics, listEventAttendees } from "../checkins.service.js";
import prisma from "../../../database/index.js";
import { ConflictError, NotFoundError, ForbiddenError, BadRequestError } from "../../../utils/error.js";
import { constants, systemMessages, logger } from "../../../config/index.js";

const errMsg = systemMessages.ERROR;
const successMsg = systemMessages.SUCCESS;

const m = vi.hoisted(() => {
  const mSocketIO = {};
  const mEmitCheckinUpdate = vi.fn();
  const mEmitScanResult = vi.fn();
  return { mSocketIO, mEmitCheckinUpdate, mEmitScanResult };
});

vi.mock("../../../database/index.js", () => ({
  default: {
    event: {
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    eventStaffAssignment: {
      findUnique: vi.fn(),
    },
    registration: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    qrToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    checkIn: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock("../../../realtime/socket.js", () => ({
  getIO: vi.fn(() => m.mSocketIO),
}));

vi.mock("../../../realtime/rooms.js", () => ({
  emitCheckinUpdate: m.mEmitCheckinUpdate,
  emitScanResult: m.mEmitScanResult,
}));

const mRedisClient = {
  set: vi.fn(),
  del: vi.fn(),
};
vi.mock("../../../config/redis.js", () => ({
  getRedisClient: vi.fn(() => mRedisClient),
}));

vi.mock("../../../utils/crypto.js", () => ({
  hashToken: vi.fn((token) => `hashed_${token}`),
}));

const mTx = {
  checkIn: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  qrToken: { update: vi.fn() },
  registration: { update: vi.fn() },
  auditLog: { create: vi.fn() },
};

describe("Checkin Service Tests", () => {
  const mockEventId = "event_1";
  const mockStaffId = "staff_1";
  const mockRegistrationId = "reg_1";
  const mockCheckInId = "checkin_1";
  const mockOwnerId = "organizer_1";

  const mockQrToken = {
    id: "qr_1",
    tokenHash: "hashed_token123",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    revokedAt: null,
    scanCount: 0,
    registrationId: mockRegistrationId,
    registration: {
      id: mockRegistrationId,
      eventId: mockEventId,
      attendeeName: "John Doe",
      attendeeEmail: "john@example.com",
      status: "CONFIRMED",
    },
  };

  const mockCheckin = {
    id: mockCheckInId,
    eventId: mockEventId,
    registrationId: mockRegistrationId,
    staffId: mockStaffId,
    result: constants.CHECKIN_RESULT.VALID,
    scannedAt: new Date(),
    deletedAt: null,
    deviceInfo: null,
    registration: {
      attendeeName: "John Doe",
      attendeeEmail: "john@example.com",
    },
    staff: {
      name: "Staff User",
      email: "staff@example.com",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn) => fn(mTx));
    prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
    prisma.eventStaffAssignment.findUnique.mockResolvedValue({ active: true });
    prisma.registration.findUnique.mockResolvedValue(null);
    prisma.registration.findMany.mockResolvedValue([]);
    prisma.registration.count.mockResolvedValue(0);
    prisma.checkIn.count.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("scanQr", () => {
    test("should acquire Redis lock and release in finally", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(mockQrToken);
      prisma.checkIn.findUnique.mockResolvedValue(null);
      mTx.checkIn.create.mockResolvedValue(mockCheckin);
      mTx.qrToken.update.mockResolvedValue({ ...mockQrToken, scanCount: 1 });

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(mRedisClient.set).toHaveBeenCalledWith(
        `scan:${mockEventId}:hashed_token123`,
        "1",
        "EX",
        10,
        "NX"
      );
      expect(mRedisClient.del).toHaveBeenCalledWith(`scan:${mockEventId}:hashed_token123`);
      expect(result.result).toBe(constants.CHECKIN_RESULT.VALID);
      expect(m.mEmitCheckinUpdate).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.VALID, attendeeName: "John Doe", totalCheckedIn: 1 })
      );
      expect(m.mEmitScanResult).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({
          result: constants.CHECKIN_RESULT.VALID,
          message: successMsg.CHECKIN.SUCCESS,
          attendee: { name: "John Doe" },
        })
      );
    });

    test("should throw ConflictError if scan already in progress", async () => {
      mRedisClient.set.mockResolvedValue(null);

      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(ConflictError);
      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.SCAN_IN_PROGRESS);
      expect(mRedisClient.del).not.toHaveBeenCalled();
    });

    test("should throw ForbiddenError if event not found", async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(ForbiddenError);
      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.NOT_AUTHORIZED);
      expect(mRedisClient.set).not.toHaveBeenCalled();
    });

    test("should throw ForbiddenError if staff is not assigned to the event", async () => {
      prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);

      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(ForbiddenError);
      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.NOT_AUTHORIZED);
      expect(mRedisClient.set).not.toHaveBeenCalled();
      expect(m.mEmitCheckinUpdate).not.toHaveBeenCalled();
    });

    test("should throw ForbiddenError if assignment is inactive", async () => {
      prisma.eventStaffAssignment.findUnique.mockResolvedValue({ active: false });

      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow(ForbiddenError);
    });

    test("should allow the event owner to scan without an assignment", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockStaffId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(mockQrToken);
      prisma.checkIn.findUnique.mockResolvedValue(null);
      mTx.checkIn.create.mockResolvedValue(mockCheckin);

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.VALID);
    });

    test("should return INVALID if QR token not found", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(null);

      const result = await scanQr(mockEventId, { token: "bad_token" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.INVALID);
      expect(result.message).toBe(errMsg.CHECKIN.INVALID_QR);
      expect(m.mEmitCheckinUpdate).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.INVALID, totalCheckedIn: 1 })
      );
      expect(m.mEmitScanResult).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.INVALID, message: errMsg.CHECKIN.INVALID_QR })
      );
    });

    test("should allow a manual check-in using an opaque registration id token", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(null);
      prisma.registration.findUnique.mockResolvedValue({
        id: mockRegistrationId,
        eventId: mockEventId,
        status: "CONFIRMED",
        attendeeName: "John Doe",
      });
      prisma.checkIn.findUnique.mockResolvedValue(null);
      mTx.checkIn.create.mockResolvedValue(mockCheckin);

      const result = await scanQr(mockEventId, { token: mockRegistrationId }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.VALID);
      expect(result.attendeeName).toBe("John Doe");
      expect(result.checkinId).toBe(mockCheckInId);
      expect(mTx.checkIn.create).toHaveBeenCalledWith({
        data: {
          eventId: mockEventId,
          registrationId: mockRegistrationId,
          staffId: mockStaffId,
          result: constants.CHECKIN_RESULT.VALID,
          deviceInfo: undefined,
        },
        include: { registration: true },
      });
      expect(mTx.qrToken.update).not.toHaveBeenCalled();
    });

    test("should return INVALID for a manual check-in token of a different event", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(null);
      prisma.registration.findUnique.mockResolvedValue({
        id: "reg-other",
        eventId: "other_event",
        status: "CONFIRMED",
        attendeeName: "Someone Else",
      });

      const result = await scanQr(mockEventId, { token: "reg-other" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.INVALID);
      expect(result.message).toBe(errMsg.CHECKIN.INVALID_QR);
      expect(mTx.checkIn.create).not.toHaveBeenCalled();
    });

    test("should return INVALID when the manual check-in registration is not confirmed", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(null);
      prisma.registration.findUnique.mockResolvedValue({
        id: mockRegistrationId,
        eventId: mockEventId,
        status: "PENDING",
        attendeeName: "John Doe",
      });

      const result = await scanQr(mockEventId, { token: mockRegistrationId }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.INVALID);
      expect(result.message).toBe(errMsg.CHECKIN.REGISTRATION_NOT_CONFIRMED);
      expect(mTx.checkIn.create).not.toHaveBeenCalled();
    });

    test("should return EXPIRED if QR token expired", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue({
        ...mockQrToken,
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      });

      const result = await scanQr(mockEventId, { token: "expired_token" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.EXPIRED);
      expect(result.message).toBe(errMsg.CHECKIN.QR_EXPIRED);
      expect(m.mEmitCheckinUpdate).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.EXPIRED, attendeeName: "John Doe" })
      );
    });

    test("should return INVALID if registration is not confirmed", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue({
        ...mockQrToken,
        registration: { ...mockQrToken.registration, status: "PENDING" },
      });

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.INVALID);
      expect(result.message).toBe(errMsg.CHECKIN.REGISTRATION_NOT_CONFIRMED);
    });

    test("should return WRONG_EVENT if eventId does not match", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue({
        ...mockQrToken,
        registration: { ...mockQrToken.registration, eventId: "other_event" },
      });

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.WRONG_EVENT);
      expect(result.message).toBe(errMsg.CHECKIN.EVENT_MISMATCH);
      expect(m.mEmitCheckinUpdate).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.WRONG_EVENT })
      );
    });

    test("should return REVOKED if token revoked and no check-in exists", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue({
        ...mockQrToken,
        revokedAt: new Date("2026-07-30T00:00:00Z"),
      });
      prisma.checkIn.findUnique.mockResolvedValue(null);

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.REVOKED);
      expect(result.message).toBe(errMsg.CHECKIN.QR_REVOKED);
    });

    test("should return DUPLICATE if already checked in", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(mockQrToken);
      prisma.checkIn.findUnique.mockResolvedValue(mockCheckin);

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.DUPLICATE);
      expect(result.message).toBe(errMsg.CHECKIN.DUPLICATE);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: mockStaffId,
          action: "DUPLICATE_SCAN",
          entity: "CheckIn",
          entityId: mockCheckInId,
          afterSnapshot: { tokenHash: "hashed_token123", attemptTime: expect.any(String) },
        },
      });
      expect(m.mEmitCheckinUpdate).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.DUPLICATE, attendeeName: "John Doe" })
      );
    });

    test("should create check-in successfully", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(mockQrToken);
      prisma.checkIn.findUnique.mockResolvedValue(null);
      mTx.checkIn.create.mockResolvedValue(mockCheckin);

      const result = await scanQr(mockEventId, { token: "token123", deviceInfo: "mobile" }, mockStaffId);

      expect(mTx.checkIn.create).toHaveBeenCalledWith({
        data: {
          eventId: mockEventId,
          registrationId: mockRegistrationId,
          staffId: mockStaffId,
          result: constants.CHECKIN_RESULT.VALID,
          deviceInfo: "mobile",
        },
        include: { registration: true },
      });
      expect(mTx.qrToken.update).toHaveBeenCalledWith({
        where: { id: mockQrToken.id },
        data: { scanCount: { increment: 1 }, revokedAt: expect.any(Date) },
      });
      expect(result.result).toBe(constants.CHECKIN_RESULT.VALID);
      expect(result.message).toBe(successMsg.CHECKIN.SUCCESS);
      expect(result.attendeeName).toBe("John Doe");
      expect(result.checkinId).toBe(mockCheckInId);
    });

    test("should restore a previously undone check-in as VALID", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(mockQrToken);
      prisma.checkIn.findUnique.mockResolvedValue({ ...mockCheckin, deletedAt: new Date("2026-07-30T00:00:00Z") });
      mTx.checkIn.update.mockResolvedValue(mockCheckin);

      const result = await scanQr(mockEventId, { token: "token123", deviceInfo: "mobile" }, mockStaffId);

      expect(mTx.checkIn.update).toHaveBeenCalledWith({
        where: { id: mockCheckInId },
        data: expect.objectContaining({
          deletedAt: null,
          staffId: mockStaffId,
          result: constants.CHECKIN_RESULT.VALID,
        }),
        include: { registration: true },
      });
      expect(mTx.qrToken.update).toHaveBeenCalledWith({
        where: { id: mockQrToken.id },
        data: { scanCount: { increment: 1 }, revokedAt: expect.any(Date) },
      });
      expect(result.result).toBe(constants.CHECKIN_RESULT.VALID);
      expect(result.checkinId).toBe(mockCheckInId);
    });

    test("should return REVOKED and not restore when token revoked with a soft-deleted check-in", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue({
        ...mockQrToken,
        revokedAt: new Date("2026-07-30T00:00:00Z"),
      });
      prisma.checkIn.findUnique.mockResolvedValue({ ...mockCheckin, deletedAt: new Date("2026-07-30T00:00:00Z") });

      const result = await scanQr(mockEventId, { token: "token123" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.REVOKED);
      expect(result.message).toBe(errMsg.CHECKIN.QR_REVOKED);
      expect(prisma.checkIn.findUnique).not.toHaveBeenCalled();
      expect(mTx.checkIn.update).not.toHaveBeenCalled();
      expect(mTx.checkIn.create).not.toHaveBeenCalled();
      expect(mTx.qrToken.update).not.toHaveBeenCalled();
    });

    test("should release lock even if an error occurs", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockRejectedValue(new Error("DB error"));

      await expect(scanQr(mockEventId, { token: "token123" }, mockStaffId))
        .rejects.toThrow("DB error");
      expect(mRedisClient.del).toHaveBeenCalled();
    });

    test("should still emit scan:result when the checkin:update emit fails", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(null);
      m.mEmitCheckinUpdate.mockImplementationOnce(() => {
        throw new Error("socket error");
      });
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const result = await scanQr(mockEventId, { token: "bad_token" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.INVALID);
      expect(warnSpy).toHaveBeenCalled();
      expect(m.mEmitScanResult).toHaveBeenCalledWith(
        m.mSocketIO,
        mockEventId,
        expect.objectContaining({ result: constants.CHECKIN_RESULT.INVALID })
      );
      expect(mRedisClient.del).toHaveBeenCalled();
    });

    test("should still return scan result and log a warning when emitScanResult fails", async () => {
      mRedisClient.set.mockResolvedValue("OK");
      prisma.qrToken.findUnique.mockResolvedValue(null);
      m.mEmitScanResult.mockImplementationOnce(() => {
        throw new Error("socket error");
      });
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const result = await scanQr(mockEventId, { token: "bad_token" }, mockStaffId);

      expect(result.result).toBe(constants.CHECKIN_RESULT.INVALID);
      expect(warnSpy).toHaveBeenCalled();
      expect(m.mEmitCheckinUpdate).toHaveBeenCalled();
      expect(mRedisClient.del).toHaveBeenCalled();
    });
  });

  describe("getCheckins", () => {
    test("should return checkins for an event", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockStaffId });
      const checkins = [mockCheckin, { ...mockCheckin, id: "checkin_2" }];
      prisma.checkIn.findMany.mockResolvedValue(checkins);

      const result = await getCheckins(mockEventId, mockStaffId);

      expect(result).toEqual(checkins);
      expect(prisma.checkIn.findMany).toHaveBeenCalledWith({
        where: { eventId: mockEventId, deletedAt: null },
        include: {
          registration: { select: { attendeeName: true, attendeeEmail: true } },
          staff: { select: { name: true, email: true } },
        },
        orderBy: { scannedAt: "desc" },
      });
    });

    test("should return empty array if no checkins", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockStaffId });
      prisma.checkIn.findMany.mockResolvedValue([]);

      const result = await getCheckins(mockEventId, mockStaffId);

      expect(result).toEqual([]);
    });

    test("should throw NotFoundError if event not found", async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(getCheckins(mockEventId, mockStaffId))
        .rejects.toThrow(NotFoundError);
      await expect(getCheckins(mockEventId, mockStaffId))
        .rejects.toThrow(errMsg.EVENT.NOT_FOUND);
    });

    test("should allow staff with an active assignment to view checkins", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue({ active: true });
      prisma.checkIn.findMany.mockResolvedValue([mockCheckin]);

      const result = await getCheckins(mockEventId, mockStaffId);

      expect(result).toEqual([mockCheckin]);
      expect(prisma.eventStaffAssignment.findUnique).toHaveBeenCalledWith({
        where: { eventId_userId: { eventId: mockEventId, userId: mockStaffId } },
        select: { active: true },
      });
    });

    test("should throw NotFoundError if staff lacks an active assignment", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);

      await expect(getCheckins(mockEventId, mockStaffId))
        .rejects.toThrow(NotFoundError);
      await expect(getCheckins(mockEventId, mockStaffId))
        .rejects.toThrow(errMsg.EVENT.NOT_FOUND);
    });
  });

  describe("undoCheckin", () => {
    test("should throw NotFoundError if checkin not found", async () => {
      prisma.checkIn.findUnique.mockResolvedValue(null);

      await expect(undoCheckin(mockEventId, "nonexistent", mockStaffId))
        .rejects.toThrow(NotFoundError);
      await expect(undoCheckin(mockEventId, "nonexistent", mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.NOT_FOUND);
    });

    test("should throw NotFoundError if checkin eventId does not match", async () => {
      prisma.checkIn.findUnique.mockResolvedValue({ ...mockCheckin, eventId: "other_event" });

      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(NotFoundError);
    });

    test("should throw NotFoundError if checkin was already undone", async () => {
      prisma.checkIn.findUnique.mockResolvedValue({ ...mockCheckin, deletedAt: new Date("2026-07-30T00:00:00Z") });

      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(NotFoundError);
    });

    test("should throw ForbiddenError if caller is neither owner nor scanning staff", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.checkIn.findUnique.mockResolvedValue({ ...mockCheckin, staffId: "other_staff_1" });

      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(ForbiddenError);
      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.UNDO_NOT_AUTHORIZED);
    });

    test("should throw NotFoundError if event not found", async () => {
      prisma.checkIn.findUnique.mockResolvedValue(mockCheckin);
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(NotFoundError);
      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(errMsg.EVENT.NOT_FOUND);
    });

    test("should allow the event owner to undo", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockStaffId });
      prisma.checkIn.findUnique.mockResolvedValue({ ...mockCheckin, staffId: "other_staff_1" });
      mTx.checkIn.updateMany.mockResolvedValue({ count: 1 });

      const result = await undoCheckin(mockEventId, mockCheckInId, mockStaffId);

      expect(result).toEqual({ success: true });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test("should throw BadRequestError if check-in is older than 24 hours", async () => {
      prisma.checkIn.findUnique.mockResolvedValue({
        ...mockCheckin,
        scannedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });

      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(BadRequestError);
      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.UNDO_WINDOW_EXPIRED);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test("should undo checkin with soft delete, registration revert, and audit log in transaction", async () => {
      prisma.checkIn.findUnique.mockResolvedValue(mockCheckin);
      mTx.checkIn.updateMany.mockResolvedValue({ count: 1 });

      const result = await undoCheckin(mockEventId, mockCheckInId, mockStaffId);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mTx.checkIn.updateMany).toHaveBeenCalledWith({
        where: { id: mockCheckInId, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mTx.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: mockStaffId,
          action: "UNDO_CHECKIN",
          entity: "CheckIn",
          entityId: mockCheckInId,
          beforeSnapshot: {
            eventId: mockCheckin.eventId,
            registrationId: mockCheckin.registrationId,
            result: mockCheckin.result,
            scannedAt: mockCheckin.scannedAt.toISOString(),
          },
        },
      });
      expect(mTx.registration.update).toHaveBeenCalledWith({
        where: { id: mockRegistrationId },
        data: { status: "CONFIRMED" },
      });
      expect(mTx.qrToken.update).toHaveBeenCalledWith({
        where: { registrationId: mockCheckin.registrationId },
        data: { revokedAt: null, scanCount: { decrement: 1 } },
      });
      expect(result).toEqual({ success: true });
    });

    test("should throw NotFoundError if updateMany affects no rows", async () => {
      prisma.checkIn.findUnique.mockResolvedValue(mockCheckin);
      mTx.checkIn.updateMany.mockResolvedValue({ count: 0 });

      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(NotFoundError);
      await expect(undoCheckin(mockEventId, mockCheckInId, mockStaffId))
        .rejects.toThrow(errMsg.CHECKIN.NOT_FOUND);
    });
  });

  describe("getCheckinStatistics", () => {
    test("should return system-wide statistics for an ADMIN", async () => {
      prisma.checkIn.count.mockResolvedValueOnce(10).mockResolvedValueOnce(9);
      prisma.$queryRaw.mockResolvedValue([{ count: 2 }]);
      prisma.auditLog.count.mockResolvedValue(1);
      prisma.event.count.mockResolvedValue(3);

      const result = await getCheckinStatistics(mockOwnerId, "ADMIN");

      expect(result.checkins).toEqual({ total: 10, valid: 9, duplicate: 1 });
      expect(result.uniqueAttendeesCheckedIn).toBe(2);
      expect(result.eventsWithCheckins).toBe(3);
      expect(prisma.event.findFirst).not.toHaveBeenCalled();
    });

    test("should throw ForbiddenError for a non-ADMIN without an eventId", async () => {
      await expect(getCheckinStatistics(mockStaffId, "STAFF")).rejects.toThrow(ForbiddenError);
      await expect(getCheckinStatistics(mockStaffId, "STAFF")).rejects.toThrow(errMsg.AUTH.FORBIDDEN);
    });

    test("should scope statistics to an event for an active staff member", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.checkIn.count.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([{ count: 2 }]);
      prisma.event.count.mockResolvedValue(1);

      const result = await getCheckinStatistics(mockStaffId, "STAFF", { eventId: mockEventId });

      expect(result.checkins).toEqual({ total: 4, valid: 3, duplicate: 2 });
      expect(result.uniqueAttendeesCheckedIn).toBe(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.checkIn.findMany).not.toHaveBeenCalled();
    });

    test("should throw NotFoundError when the scoped event does not exist", async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(
        getCheckinStatistics(mockStaffId, "STAFF", { eventId: mockEventId })
      ).rejects.toThrow(NotFoundError);
    });

    test("should throw ForbiddenError when a staff member is not assigned to the event", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);

      await expect(
        getCheckinStatistics(mockStaffId, "STAFF", { eventId: mockEventId })
      ).rejects.toThrow(ForbiddenError);
    });

    test("should allow the event owner to view scoped statistics", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.checkIn.count.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([{ count: 0 }]);
      prisma.event.count.mockResolvedValue(1);

      const result = await getCheckinStatistics(mockOwnerId, "ORGANIZER", { eventId: mockEventId });

      expect(result.checkins.duplicate).toBe(0);
      expect(result.uniqueAttendeesCheckedIn).toBe(1);
      expect(prisma.eventStaffAssignment.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("listEventAttendees", () => {
    const mockRegistrations = [
      {
        id: "reg_1",
        eventId: mockEventId,
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        phone: "+2348000000000",
        confirmationCode: "QPC-ADA123",
        ticketCode: { code: "EVNT-ABC1" },
        ticketType: { id: "tt_1", name: "VIP" },
        status: "CONFIRMED",
        paymentStatus: "SUCCESS",
        qrIssued: true,
        qrToken: { id: "qr_1", revokedAt: null, expiresAt: new Date("2099-01-01T00:00:00Z") },
        checkins: [{ id: "checkin_1", result: constants.CHECKIN_RESULT.VALID, scannedAt: new Date() }],
      },
      {
        id: "reg_2",
        eventId: mockEventId,
        attendeeName: "Bob Builder",
        attendeeEmail: "bob@example.com",
        phone: null,
        confirmationCode: "QPC-BOB123",
        ticketCode: { code: "EVNT-BOB1" },
        ticketType: null,
        status: "CONFIRMED",
        paymentStatus: "PENDING",
        qrIssued: false,
        qrToken: null,
        checkins: [],
      },
    ];

    test("should allow the event owner to list attendees", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.registration.findMany.mockResolvedValue(mockRegistrations);
      prisma.registration.count.mockResolvedValue(2);

      const result = await listEventAttendees(mockEventId, mockOwnerId, "ORGANIZER", {});

      expect(result.attendees).toHaveLength(2);
      expect(result.attendees[0]).toEqual(
        expect.objectContaining({
          id: "reg_1",
          attendeeName: "Ada Lovelace",
          attendeeEmail: "ada@example.com",
          phone: "+2348000000000",
          confirmationCode: "QPC-ADA123",
          ticketCode: "EVNT-ABC1",
          status: "CONFIRMED",
          checkedIn: true,
          qr: { token: "reg_1", issued: true },
        })
      );
      expect(result.attendees[1].checkedIn).toBe(false);
      expect(result.attendees[1].qr.issued).toBe(false);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(prisma.eventStaffAssignment.findUnique).not.toHaveBeenCalled();
    });

    test("should allow an active assigned staff member to list attendees", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue({ active: true });
      prisma.registration.findMany.mockResolvedValue(mockRegistrations);
      prisma.registration.count.mockResolvedValue(2);

      const result = await listEventAttendees(mockEventId, mockStaffId, "STAFF", {});

      expect(result.attendees).toHaveLength(2);
      expect(prisma.eventStaffAssignment.findUnique).toHaveBeenCalledWith({
        where: { eventId_userId: { eventId: mockEventId, userId: mockStaffId } },
        select: { active: true },
      });
    });

    test("should allow an ADMIN to list attendees without an assignment", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);
      prisma.registration.findMany.mockResolvedValue(mockRegistrations);
      prisma.registration.count.mockResolvedValue(2);

      const result = await listEventAttendees(mockEventId, mockStaffId, "ADMIN", {});

      expect(result.attendees).toHaveLength(2);
      expect(prisma.eventStaffAssignment.findUnique).not.toHaveBeenCalled();
    });

    test("should throw ForbiddenError for a user who is not the owner nor assigned staff", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);

      await expect(listEventAttendees(mockEventId, mockStaffId, "STAFF", {}))
        .rejects.toThrow(ForbiddenError);
      await expect(listEventAttendees(mockEventId, mockStaffId, "STAFF", {}))
        .rejects.toThrow(errMsg.CHECKIN.NOT_AUTHORIZED);
    });

    test("should throw ForbiddenError for an inactive staff assignment", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue({ active: false });

      await expect(listEventAttendees(mockEventId, mockStaffId, "STAFF", {}))
        .rejects.toThrow(ForbiddenError);
    });

    test("should throw NotFoundError if the event does not exist", async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(listEventAttendees(mockEventId, mockOwnerId, "ORGANIZER", {}))
        .rejects.toThrow(NotFoundError);
      await expect(listEventAttendees(mockEventId, mockOwnerId, "ORGANIZER", {}))
        .rejects.toThrow(errMsg.EVENT.NOT_FOUND);
    });

    test("should apply search across name, email, phone, and confirmation code", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.registration.findMany.mockResolvedValue([mockRegistrations[0]]);
      prisma.registration.count.mockResolvedValue(1);

      await listEventAttendees(mockEventId, mockOwnerId, "ORGANIZER", { q: "Ada", page: 2, limit: 10, status: "CONFIRMED" });

      expect(prisma.registration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            eventId: mockEventId,
            status: "CONFIRMED",
            OR: [
              { attendeeName: { contains: "Ada", mode: "insensitive" } },
              { attendeeEmail: { contains: "Ada", mode: "insensitive" } },
              { phone: { contains: "Ada", mode: "insensitive" } },
              { confirmationCode: { contains: "Ada", mode: "insensitive" } },
            ],
          },
          skip: 10,
          take: 10,
        })
      );
      expect(prisma.registration.count).toHaveBeenCalledWith({
        where: {
          eventId: mockEventId,
          status: "CONFIRMED",
          OR: [
            { attendeeName: { contains: "Ada", mode: "insensitive" } },
            { attendeeEmail: { contains: "Ada", mode: "insensitive" } },
            { phone: { contains: "Ada", mode: "insensitive" } },
            { confirmationCode: { contains: "Ada", mode: "insensitive" } },
          ],
        },
      });
    });

    test("should ignore a blank search term", async () => {
      prisma.event.findFirst.mockResolvedValue({ ownerId: mockOwnerId });
      prisma.registration.findMany.mockResolvedValue(mockRegistrations);
      prisma.registration.count.mockResolvedValue(2);

      await listEventAttendees(mockEventId, mockOwnerId, "ORGANIZER", { q: "   " });

      expect(prisma.registration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: mockEventId } })
      );
    });
  });
});
