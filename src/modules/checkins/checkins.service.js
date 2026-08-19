import prisma from "../../database/index.js";
import { Prisma } from "@prisma/client";
import { getRedisClient } from "../../config/redis.js";
import { hashToken } from "../../utils/crypto.js";
import { NotFoundError, ConflictError, ForbiddenError, BadRequestError } from "../../utils/error.js";
import { constants, systemMessages, logger } from "../../config/index.js";
import { getIO } from "../../realtime/socket.js";
import { emitCheckinUpdate, emitScanResult } from "../../realtime/rooms.js";

const errMsg = systemMessages.ERROR;
const successMsg = systemMessages.SUCCESS;
const HOURS_24_MS = 24 * 60 * 60 * 1000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function scanQr(eventId, data, staffId) {
  const redis = getRedisClient();
  const tokenHash = hashToken(data.token);

  const [event, assignment] = await Promise.all([
    prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: { ownerId: true },
    }),
    prisma.eventStaffAssignment.findUnique({
      where: { eventId_userId: { eventId, userId: staffId } },
      select: { active: true },
    }),
  ]);

  if (!event || (event.ownerId !== staffId && !assignment?.active)) {
    throw new ForbiddenError(errMsg.CHECKIN.NOT_AUTHORIZED);
  }

  const lockKey = `scan:${eventId}:${tokenHash}`;
  let lockHeld = false;
  try {
    lockHeld = Boolean(await redis.set(lockKey, "1", "EX", 10, "NX"));
  } catch (err) {
    logger.warn({ err, eventId }, "Redis lock unavailable; proceeding without dedupe lock");
  }

  if (!lockHeld) {
    throw new ConflictError(errMsg.CHECKIN.SCAN_IN_PROGRESS);
  }

  try {
    const qrToken = await prisma.qrToken.findUnique({
      where: { tokenHash },
      include: { registration: true },
    });

    let scanResult;
    let attendeeName;

    if (!qrToken) {
      // Staff manual check-in: the token may be an opaque registration id
      // returned by the attendee lookup (GET /checkins/:eventId/attendees),
      // used to check in someone whose QR cannot be scanned (e.g. camera
      // failure). Identity is verified by the staff member at the gate.
      // Only registration UUIDs are valid manual lookup keys; any other
      // token is an invalid scan and never hits the database.
      if (!UUID_REGEX.test(data.token)) {
        scanResult = { result: constants.CHECKIN_RESULT.INVALID, message: errMsg.CHECKIN.INVALID_QR };
      } else {
        const manualRegistration = await prisma.registration.findUnique({
          where: { id: data.token },
          select: { id: true, eventId: true, status: true, attendeeName: true },
        });

        if (!manualRegistration || manualRegistration.eventId !== eventId) {
          scanResult = { result: constants.CHECKIN_RESULT.INVALID, message: errMsg.CHECKIN.INVALID_QR };
        } else if (manualRegistration.status !== "CONFIRMED") {
          attendeeName = manualRegistration.attendeeName;
          scanResult = { result: constants.CHECKIN_RESULT.INVALID, message: errMsg.CHECKIN.REGISTRATION_NOT_CONFIRMED };
        } else {
          const resolved = await resolveCheckIn({
            eventId,
            registrationId: manualRegistration.id,
            staffId,
            deviceInfo: data.deviceInfo,
            tokenHash,
            qrTokenId: null,
          });
          attendeeName = resolved.attendeeName;
          scanResult = resolved.scanResult;
        }
      }
    } else if (new Date(qrToken.expiresAt) < new Date()) {
      attendeeName = qrToken.registration.attendeeName;
      scanResult = { result: constants.CHECKIN_RESULT.EXPIRED, message: errMsg.CHECKIN.QR_EXPIRED };
    } else if (qrToken.registration.status !== "CONFIRMED") {
      attendeeName = qrToken.registration.attendeeName;
      scanResult = { result: constants.CHECKIN_RESULT.INVALID, message: errMsg.CHECKIN.REGISTRATION_NOT_CONFIRMED };
    } else if (qrToken.registration.eventId !== eventId) {
      attendeeName = qrToken.registration.attendeeName;
      scanResult = { result: constants.CHECKIN_RESULT.WRONG_EVENT, message: errMsg.CHECKIN.EVENT_MISMATCH };
    } else if (qrToken.revokedAt) {
      attendeeName = qrToken.registration.attendeeName;
      scanResult = { result: constants.CHECKIN_RESULT.REVOKED, message: errMsg.CHECKIN.QR_REVOKED };
    } else {
      const resolved = await resolveCheckIn({
        eventId,
        registrationId: qrToken.registrationId,
        staffId,
        deviceInfo: data.deviceInfo,
        tokenHash,
        qrTokenId: qrToken.id,
      });
      attendeeName = resolved.attendeeName;
      scanResult = resolved.scanResult;
    }

    try {
      const totalCheckedIn = await prisma.checkIn.count({
        where: { eventId, result: constants.CHECKIN_RESULT.VALID, deletedAt: null },
      });

      emitCheckinUpdate(getIO(), eventId, {
        result: scanResult.result,
        attendeeName,
        totalCheckedIn,
      });
    } catch (err) {
      logger.warn({ err, eventId }, "failed to emit checkin:update");
    }

    try {
      emitScanResult(getIO(), eventId, {
        result: scanResult.result,
        message: scanResult.message,
        ...(attendeeName ? { attendee: { name: attendeeName } } : {}),
      });
    } catch (err) {
      logger.warn({ err, eventId }, "failed to emit scan:result");
    }

    return scanResult;
  } finally {
    if (lockHeld) {
      try {
        await redis.del(lockKey);
      } catch (err) {
        logger.warn({ err, eventId }, "Failed to release scan lock");
      }
    }
  }
}

/**
 * Create a VALID check-in (or restore a previously undone one) for a
 * registration, revoking the QR token when the check-in originated from a QR
 * scan (`qrTokenId` is set). Used by both the QR-scan path and the staff
 * manual check-in path.
 *
 * @param {Object} params
 * @param {string} params.eventId - Event UUID
 * @param {string} params.registrationId - Registration UUID to check in
 * @param {string} params.staffId - ID of the staff member performing the scan
 * @param {string} [params.deviceInfo] - Device info attached to the check-in
 * @param {string} params.tokenHash - Hash of the presented token (for audit)
 * @param {string|null} params.qrTokenId - QR token id to revoke, or null for manual check-ins
 * @returns {Promise<{ scanResult: Object, attendeeName: string }>}
 */
async function resolveCheckIn({ eventId, registrationId, staffId, deviceInfo, tokenHash, qrTokenId }) {
  const existingCheckin = await prisma.checkIn.findUnique({
    where: { eventId_registrationId: { eventId, registrationId } },
    include: { registration: { select: { attendeeName: true } } },
  });

  if (existingCheckin && !existingCheckin.deletedAt) {
    await prisma.auditLog.create({
      data: {
        actorId: staffId,
        action: "DUPLICATE_SCAN",
        entity: "CheckIn",
        entityId: existingCheckin.id,
        afterSnapshot: { tokenHash, attemptTime: new Date().toISOString() },
      },
    });
    return {
      attendeeName: existingCheckin.registration?.attendeeName ?? null,
      scanResult: { result: constants.CHECKIN_RESULT.DUPLICATE, message: errMsg.CHECKIN.DUPLICATE },
    };
  }
  if (existingCheckin) {
    const restored = await prisma.$transaction(async (tx) => {
      const checkin = await tx.checkIn.update({
        where: { id: existingCheckin.id },
        data: {
          deletedAt: null,
          staffId,
          result: constants.CHECKIN_RESULT.VALID,
          scannedAt: new Date(),
          deviceInfo,
        },
        include: { registration: true },
      });

      if (qrTokenId) {
        await tx.qrToken.update({
          where: { id: qrTokenId },
          data: { scanCount: { increment: 1 }, revokedAt: new Date() },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: staffId,
          action: "CHECKIN_VALID",
          entity: "CheckIn",
          entityId: checkin.id,
          afterSnapshot: {
            tokenHash,
            restored: true,
            scannedAt: checkin.scannedAt.toISOString(),
          },
        },
      });

      return checkin;
    });

    return {
      attendeeName: restored.registration.attendeeName,
      scanResult: {
        result: constants.CHECKIN_RESULT.VALID,
        message: successMsg.CHECKIN.SUCCESS,
        attendeeName: restored.registration.attendeeName,
        checkinId: restored.id,
      },
    };
  }

  const checkin = await prisma.$transaction(async (tx) => {
    const created = await tx.checkIn.create({
      data: {
        eventId,
        registrationId,
        staffId,
        result: constants.CHECKIN_RESULT.VALID,
        deviceInfo,
      },
      include: { registration: true },
    });

    if (qrTokenId) {
      await tx.qrToken.update({
        where: { id: qrTokenId },
        data: { scanCount: { increment: 1 }, revokedAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: staffId,
        action: "CHECKIN_VALID",
        entity: "CheckIn",
        entityId: created.id,
        afterSnapshot: {
          tokenHash,
          scannedAt: created.scannedAt.toISOString(),
        },
      },
    });

    return created;
  });

  return {
    attendeeName: checkin.registration.attendeeName,
    scanResult: {
      result: constants.CHECKIN_RESULT.VALID,
      message: successMsg.CHECKIN.SUCCESS,
      attendeeName: checkin.registration.attendeeName,
      checkinId: checkin.id,
    },
  };
}

export async function getCheckins(eventId, userId) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { ownerId: true },
  });

  if (!event) {
    throw new NotFoundError(errMsg.EVENT.NOT_FOUND);
  }

  if (event.ownerId !== userId) {
    const assignment = await prisma.eventStaffAssignment.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { active: true },
    });

    if (!assignment?.active) {
      throw new NotFoundError(errMsg.EVENT.NOT_FOUND);
    }
  }

  return prisma.checkIn.findMany({
    where: { eventId, deletedAt: null },
    include: {
      registration: { select: { attendeeName: true, attendeeEmail: true } },
      staff: { select: { name: true, email: true } },
    },
    orderBy: { scannedAt: "desc" },
  });
}

export async function undoCheckin(eventId, checkInId, staffId) {
  const checkin = await prisma.checkIn.findUnique({ where: { id: checkInId } });
  if (!checkin) throw new NotFoundError(errMsg.CHECKIN.NOT_FOUND);
  if (checkin.eventId !== eventId) throw new NotFoundError(errMsg.CHECKIN.NOT_FOUND);
  if (checkin.deletedAt) throw new NotFoundError(errMsg.CHECKIN.NOT_FOUND);

  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!event) throw new NotFoundError(errMsg.EVENT.NOT_FOUND);

  if (event.ownerId !== staffId && checkin.staffId !== staffId) {
    throw new ForbiddenError(errMsg.CHECKIN.UNDO_NOT_AUTHORIZED);
  }

  if (Date.now() - new Date(checkin.scannedAt).getTime() > HOURS_24_MS) {
    throw new BadRequestError(errMsg.CHECKIN.UNDO_WINDOW_EXPIRED);
  }

  await prisma.$transaction(async (tx) => {
    const result = await tx.checkIn.updateMany({
      where: { id: checkInId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundError(errMsg.CHECKIN.NOT_FOUND);
    }

    await tx.auditLog.create({
      data: {
        actorId: staffId,
        action: "UNDO_CHECKIN",
        entity: "CheckIn",
        entityId: checkInId,
        beforeSnapshot: {
          eventId: checkin.eventId,
          registrationId: checkin.registrationId,
          result: checkin.result,
          scannedAt: checkin.scannedAt.toISOString(),
        },
      },
    });

    await tx.registration.update({
      where: { id: checkin.registrationId },
      data: { status: "CONFIRMED" },
    });

    // Reverse the QR-token state only for QR-backed check-ins. A manual
    // check-in (resolveCheckIn with qrTokenId: null) never incremented
    // scanCount or revoked the token, so undoing one must not touch the QR
    // token; registrations without a QR token are skipped as well.
    const qrToken = await tx.qrToken.findUnique({
      where: { registrationId: checkin.registrationId },
      select: { id: true, revokedAt: true },
    });
    if (qrToken?.revokedAt) {
      await tx.qrToken.update({
        where: { id: qrToken.id },
        data: { revokedAt: null, scanCount: { decrement: 1 } },
      });
    }
  });

  return { success: true };
}

/**
 * Count distinct registrations that have at least one active check-in,
 * computed in the database so no identifier arrays are materialized.
 *
 * @param {string} [eventId] - Optional event to scope the count to
 * @returns {Promise<number>}
 */
async function countDistinctCheckedInRegistrations(eventId) {
  const scope = eventId ? Prisma.sql`AND event_id = ${eventId}` : Prisma.empty;

  const rows = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT registration_id)::int AS count
    FROM check_ins
    WHERE deleted_at IS NULL ${scope}
  `;

  return Number(rows[0]?.count ?? 0);
}

/**
 * Count `DUPLICATE_SCAN` audit-log entries for check-ins. Scoped to an event
 * via a database-side join (no per-check-in id collection) when `eventId` is
 * given; otherwise returns the system-wide audit-log count.
 *
 * @param {string} [eventId] - Optional event to scope the count to
 * @returns {Promise<number>}
 */
async function countDuplicateScans(eventId) {
  if (!eventId) {
    return prisma.auditLog.count({
      where: { action: "DUPLICATE_SCAN", entity: "CheckIn" },
    });
  }

  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM audit_logs a
    INNER JOIN check_ins c ON c.id = a.entity_id
    WHERE a.action = 'DUPLICATE_SCAN'
      AND a.entity = 'CheckIn'
      AND c.deleted_at IS NULL
      AND c.event_id = ${eventId}
  `;

  return Number(rows[0]?.count ?? 0);
}

/**
 * Aggregate check-in statistics. Without an `eventId` this is a system-wide
 * summary (ADMIN only); with an `eventId` the caller must be the event owner,
 * an ADMIN, or an active assigned staff member (mirrors `getDashboardStats`).
 *
 * @param {string} userId - ID of the authenticated caller
 * @param {string} userRole - Role of the authenticated caller
 * @param {Object} [options]
 * @param {string} [options.eventId] - Optional event to scope statistics to
 * @returns {Promise<{ checkins: { total, valid, duplicate }, uniqueAttendeesCheckedIn: number, eventsWithCheckins: number }>}
 * @throws {ForbiddenError} If the caller lacks permission
 * @throws {NotFoundError} If the scoped event does not exist
 */
export async function getCheckinStatistics(userId, userRole, { eventId } = {}) {
  if (eventId) {
    const event = await prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: { ownerId: true },
    });

    if (!event) {
      throw new NotFoundError(errMsg.EVENT.NOT_FOUND);
    }

    if (event.ownerId !== userId && userRole !== constants.ROLES.ADMIN) {
      const assignment = await prisma.eventStaffAssignment.findUnique({
        where: { eventId_userId: { eventId, userId } },
        select: { active: true },
      });

      if (!assignment?.active) {
        throw new ForbiddenError(errMsg.CHECKIN.NOT_AUTHORIZED);
      }
    }
  } else if (userRole !== constants.ROLES.ADMIN) {
    throw new ForbiddenError(errMsg.AUTH.FORBIDDEN);
  }

  const checkinWhere = { deletedAt: null, ...(eventId && { eventId }) };

  const [total, valid, uniqueAttendeesCheckedIn, duplicate] = await Promise.all([
    prisma.checkIn.count({ where: checkinWhere }),
    prisma.checkIn.count({
      where: { ...checkinWhere, result: constants.CHECKIN_RESULT.VALID },
    }),
    countDistinctCheckedInRegistrations(eventId),
    countDuplicateScans(eventId),
  ]);

  const eventsWithCheckins = await prisma.event.count({
    where: {
      ...(eventId && { id: eventId }),
      deletedAt: null,
      checkins: { some: { deletedAt: null } },
    },
  });

  return {
    checkins: {
      total,
      valid,
      duplicate,
    },
    uniqueAttendeesCheckedIn,
    eventsWithCheckins,
  };
}

const MAX_ATTENDEE_PAGE_SIZE = 100;

/**
 * List event attendees for the gate check-in flow.
 *
 * Access rule mirrors scan + dashboard: the event owner, an ADMIN, or an
 * active assigned staff member. Unassigned users receive a 403.
 *
 * Supports search by attendee name, email, phone, or confirmation code via
 * `q`, an optional registration `status` filter, and pagination. Each row
 * includes an opaque `qr.token` (the registration UUID) that the scan
 * endpoint accepts so staff can perform a manual check-in when the attendee's
 * QR cannot be scanned.
 *
 * @param {string} eventId - UUID of the event
 * @param {string} userId - ID of the authenticated caller
 * @param {string} userRole - Role of the authenticated caller
 * @param {Object} [query] - { q, page, limit, status }
 * @returns {Promise<{ attendees: Array<Object>, pagination: Object }>}
 * @throws {NotFoundError} If the event does not exist
 * @throws {ForbiddenError} If the caller is not the owner, ADMIN, or active staff
 */
export async function listEventAttendees(eventId, userId, userRole, query = {}) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { ownerId: true },
  });

  if (!event) {
    throw new NotFoundError(errMsg.EVENT.NOT_FOUND);
  }

  const isOwner = event.ownerId === userId;
  const isAdmin = userRole === constants.ROLES.ADMIN;

  if (!isOwner && !isAdmin) {
    const assignment = await prisma.eventStaffAssignment.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { active: true },
    });

    if (!assignment?.active) {
      throw new ForbiddenError(errMsg.CHECKIN.NOT_AUTHORIZED);
    }
  }

  const take = Math.min(MAX_ATTENDEE_PAGE_SIZE, Math.max(1, Number(query.limit) || 20));
  const currentPage = Math.max(1, Number(query.page) || 1);
  const skip = (currentPage - 1) * take;

  const where = { eventId };
  if (query.status) {
    where.status = query.status;
  }

  const search = typeof query.q === "string" ? query.q.trim() : "";
  if (search) {
    where.OR = [
      { attendeeName: { contains: search, mode: "insensitive" } },
      { attendeeEmail: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
      { confirmationCode: { contains: search, mode: "insensitive" } },
    ];
  }

  const [registrations, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        ticketCode: { select: { code: true } },
        ticketType: { select: { id: true, name: true } },
        qrToken: { select: { id: true, revokedAt: true, expiresAt: true } },
        checkins: {
          where: { deletedAt: null },
          select: { id: true, result: true, scannedAt: true },
        },
      },
    }),
    prisma.registration.count({ where }),
  ]);

  const attendees = registrations.map((registration) => ({
    id: registration.id,
    attendeeName: registration.attendeeName,
    attendeeEmail: registration.attendeeEmail,
    phone: registration.phone ?? null,
    confirmationCode: registration.confirmationCode ?? null,
    ticketCode: registration.ticketCode?.code ?? null,
    ticketType: registration.ticketType,
    status: registration.status,
    paymentStatus: registration.paymentStatus,
    checkedIn: registration.checkins.some(
      (checkin) => checkin.result === constants.CHECKIN_RESULT.VALID
    ),
    qr: {
      token: registration.id,
      issued: registration.qrToken != null && registration.qrToken.revokedAt === null,
    },
  }));

  return {
    attendees,
    pagination: {
      page: currentPage,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
    },
  };
}
