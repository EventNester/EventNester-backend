import prisma from "../../database/index.js";
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from "../../utils/error.js";
import { systemMessages, constants } from "../../config/index.js";
import { writeAuditLog } from "../../utils/audit-log.js";

const MAX_PAGE_SIZE = 100;

const msg = systemMessages.ERROR;

/**
 * Helper to ensure the event exists and the user is its owner.
 * Platform admins (ADMIN) are allowed through regardless of ownership.
 */
async function checkEventOwnership(eventId, userId, userRole) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { ownerId: true, deletedAt: true },
  });

  if (!event || event.deletedAt) {
    throw new NotFoundError(msg.EVENT.NOT_FOUND);
  }

  if (event.ownerId !== userId && userRole !== constants.ROLES.ADMIN) {
    throw new ForbiddenError(msg.EVENT.UNAUTHORIZED);
  }
}

export async function createTicketType(eventId, userId, userRole, data) {
  await checkEventOwnership(eventId, userId, userRole);

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const ticketType = await prisma.$transaction(async (tx) => {
        const maxSortOrder = await tx.ticketType.aggregate({
          where: { eventId },
          _max: { sortOrder: true },
        });

        const sortOrder = (maxSortOrder._max.sortOrder ?? -1) + 1;

        return tx.ticketType.create({
          data: {
            eventId,
            ...data,
            sortOrder,
          },
        });
      });

      writeAuditLog({
        actorId: userId,
        action: 'TICKET_TYPE_CREATED',
        entity: 'TicketType',
        entityId: ticketType.id,
        afterSnapshot: { eventId, name: ticketType.name, price: ticketType.price, isPaid: ticketType.isPaid },
      });

      return ticketType;
    } catch (err) {
      if (err.code === 'P2002' && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }
}

export async function getTicketTypes(eventId, userId, userRole) {
  await checkEventOwnership(eventId, userId, userRole);

  const ticketTypes = await prisma.ticketType.findMany({
    where: { eventId },
    orderBy: { sortOrder: "asc" },
  });

  return ticketTypes;
}

export async function updateTicketType(eventId, ticketTypeId, userId, userRole, data) {
  await checkEventOwnership(eventId, userId, userRole);

  const ticketType = await prisma.ticketType.findFirst({
    where: { id: ticketTypeId, eventId },
  });

  if (!ticketType) {
    throw new NotFoundError(msg.GENERAL.NOT_FOUND);
  }

  const updated = await prisma.ticketType.update({
    where: { id: ticketTypeId },
    data,
  });

  writeAuditLog({
    actorId: userId,
    action: 'TICKET_TYPE_UPDATED',
    entity: 'TicketType',
    entityId: ticketTypeId,
    beforeSnapshot: { name: ticketType.name, price: ticketType.price, isPaid: ticketType.isPaid, capacity: ticketType.capacity, active: ticketType.active },
    afterSnapshot: { name: updated.name, price: updated.price, isPaid: updated.isPaid, capacity: updated.capacity, active: updated.active },
  });

  return updated;
}

export async function deleteTicketType(eventId, ticketTypeId, userId, userRole) {
  await checkEventOwnership(eventId, userId, userRole);

  const deletedTicketType = await prisma.$transaction(async (tx) => {
    const ticketType = await tx.ticketType.findFirst({
      where: { id: ticketTypeId, eventId },
    });

    if (!ticketType) {
      throw new NotFoundError(msg.GENERAL.NOT_FOUND);
    }

    try {
      await tx.ticketType.delete({
        where: { id: ticketTypeId },
      });
      return ticketType;
    } catch (err) {
      if (err.code === 'P2003') {
        throw new ConflictError("Cannot delete ticket type with existing registrations");
      }
      throw err;
    }
  });

  writeAuditLog({
    actorId: userId,
    action: 'TICKET_TYPE_DELETED',
    entity: 'TicketType',
    entityId: ticketTypeId,
    beforeSnapshot: { eventId, name: deletedTicketType.name, price: deletedTicketType.price, isPaid: deletedTicketType.isPaid },
  });

  return true;
}

export async function getTicketDetails(ticketId, userId, userRole) {
  const { getRegistrationById } = await import("../registrations/registration.service.js");
  const { qrService } = await import("./qr.service.js");

  const registration = await getRegistrationById(ticketId);

  const event = await prisma.event.findUnique({
    where: { id: registration.eventId },
    select: { ownerId: true, endTime: true },
  });

  const isOwner = event && event.ownerId === userId;
  const isAdmin = userRole === constants.ROLES.ADMIN;
  let canViewToken = isOwner || isAdmin;

  if (!isOwner && !isAdmin) {
    const isStaff = await prisma.eventStaffAssignment.findUnique({
      where: { eventId_userId: { eventId: registration.eventId, userId } },
      select: { active: true },
    });

    if (!isStaff?.active) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.email.toLowerCase() !== registration.attendeeEmail.toLowerCase()) {
        throw new ForbiddenError(msg.EVENT.UNAUTHORIZED);
      }
      canViewToken = true;
    }
  }

  // Recover the opaque scan token only for authorized viewers. Staff may view
  // ticket details but never receive the raw token (owner / ADMIN / holder only).
  let rawToken = null;
  if (canViewToken) {
    const qrToken = await prisma.qrToken.findUnique({
      where: { registrationId: registration.id },
    });
    if (qrToken) {
      rawToken = await qrService.recoverRawToken(qrToken, event);
    }
  }

  // The QR image must encode the raw scan token — never the confirmation code.
  let qrDataUrl = null;
  if (rawToken) {
    const qrBuffer = await qrService.createQrImage(rawToken);
    qrDataUrl = `data:image/png;base64,${qrBuffer.toString("base64")}`;
  }

  return {
    ...registration,
    qr: { token: rawToken, image: qrDataUrl },
    qrDataUrl,
  };
}

export async function listEventTickets(eventId, userId, userRole, filters = {}) {
  await checkEventOwnership(eventId, userId, userRole);

  const { listRegistrationsByEvent } = await import("../registrations/registration.service.js");
  return listRegistrationsByEvent(eventId, filters.page, filters.limit, filters);
}

export async function exportEventTickets(eventId, userId, userRole, format) {
  await checkEventOwnership(eventId, userId, userRole);

  const registrations = await prisma.registration.findMany({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
    include: {
      ticketCode: true,
      ticketType: true,
    },
  });
  
  const event = await prisma.event.findUnique({ where: { id: eventId } });

  if (format === "csv") {
    // Generate CSV string
    const headers = ["Name", "Email", "Ticket Type", "Status", "Payment", "Ticket Code"];
    const rows = registrations.map(reg => [
      reg.attendeeName || "",
      reg.attendeeEmail || "",
      reg.ticketType?.name || "",
      reg.status || "",
      reg.paymentStatus || "",
      reg.ticketCode?.code || ""
    ]);

    const escapeCsv = (value) => {
      const str = String(value);
      const safeValue = /^[\t\r\n ]*[=+\-@]/.test(str) ? `'${str}` : str;
      return `"${safeValue.replace(/"/g, '""')}"`;
    };
    
    const csvContent = [
      headers.map(escapeCsv).join(","),
      ...rows.map(row => row.map(escapeCsv).join(","))    ].join("\n");

    return { contentType: "text/csv", data: csvContent, extension: "csv" };
  } else if (format === "pdf") {
    const { generateTicketListPdf } = await import("./ticket-pdf.service.js");
    const pdfBuffer = await generateTicketListPdf(registrations, event);
    return { contentType: "application/pdf", data: pdfBuffer, extension: "pdf" };
  }

  throw new BadRequestError("Unsupported export format");
}

/**
 * List all tickets owned by a single attendee (their ticket history), matched
 * by the caller's email against registration attendee emails. Always scoped to
 * the authenticated user - no role gate, so organizers/staff/admins can also
 * retrieve their own tickets.
 *
 * Soft-deleted and cancelled events are excluded from history; cancelled
 * registrations on a live event are still shown so an attendee can see what
 * they signed up for.
 *
 * @param {string} userId - ID of the authenticated caller
 * @param {number} [page=1] - 1-indexed page number
 * @param {number} [limit=20] - Items per page
 * @returns {Promise<{ tickets: Array<Object>, pagination: { page, limit, total, totalPages } }>}
 * @throws {NotFoundError} If the user does not exist
 */
export async function listMyTickets(userId, page = 1, limit = 20) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user) {
    throw new NotFoundError(msg.GENERAL.NOT_FOUND);
  }

  const take = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const skip = (currentPage - 1) * take;

  // Case-insensitive match so registration emails entered with different casing
  // still resolve to the same account.
  const where = {
    attendeeEmail: { equals: user.email, mode: "insensitive" },
    event: {
      deletedAt: null,
      status: { not: constants.EVENT_STATUS.CANCELLED },
    },
  };

  const [registrations, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        event: {
          select: {
            id: true,
            title: true,
            slug: true,
            venue: true,
            startTime: true,
            endTime: true,
            status: true,
          },
        },
        ticketType: { select: { id: true, name: true, price: true } },
        ticketCode: { select: { code: true } },
        qrToken: true,
        checkins: { where: { deletedAt: null }, select: { id: true, scannedAt: true, result: true } },
      },
    }),
    prisma.registration.count({ where }),
  ]);

  const { qrService } = await import("./qr.service.js");

  const tickets = [];
  for (const registration of registrations) {
    // Recover the opaque scan token so passes survive a device Sync. Revoked
    // (already checked-in) tickets yield no token and never get rotated.
    let scanToken = null;
    if (registration.qrToken) {
      scanToken = await qrService.recoverRawToken(registration.qrToken, registration.event);
    }

    tickets.push({
      id: registration.id,
      attendeeName: registration.attendeeName,
      attendeeEmail: registration.attendeeEmail,
      status: registration.status,
      paymentStatus: registration.paymentStatus,
      confirmationCode: registration.confirmationCode,
      ticketType: registration.ticketType,
      ticketCode: registration.ticketCode?.code ?? null,
      qr: { token: scanToken, image: null },
      checkedIn: registration.checkins.some(
        (checkin) => checkin.result === constants.CHECKIN_RESULT.VALID
      ),
      event: registration.event,
      createdAt: registration.createdAt,
    });
  }

  return {
    tickets,
    pagination: {
      page: currentPage,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
    },
  };
}
