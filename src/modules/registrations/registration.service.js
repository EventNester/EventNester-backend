import { randomBytes } from 'crypto';
import prisma from '../../database/index.js';
import {
  NotFoundError,
  BadRequestError,
  ConflictError,
} from '../../utils/error.js';
import { constants, systemMessages, logger } from '../../config/index.js';
import { qrService } from '../tickets/qr.service.js';
import { sendNotification } from '../notifications/notification.service.js';
import { getIO } from '../../realtime/socket.js';
import { emitRegistrationNew } from '../../realtime/rooms.js';

const msg = systemMessages.ERROR;
const EVENT_OPEN_STATUSES = [
  constants.EVENT_STATUS.PUBLISHED,
  constants.EVENT_STATUS.ACTIVE,
];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 standard maximum length for email addresses
const CONFIRMATION_CODE_RETRIES = 3;

/**
 * Normalize an email address to a canonical lowercase form.
 * @param {string} email - Raw email from the client
 * @returns {string} Trimmed, lowercased email
 */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Generate a short human-friendly ticket code for an event.
 * @param {string} eventId - UUID of the event (used as a code prefix)
 * @returns {string} Formatted ticket code
 */
function generateTicketCode(eventId) {
  const prefix = eventId ? eventId.slice(0, 4).toUpperCase() : 'EVNT';
  const rand = randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${rand}`;
}

/**
 * Generate a unique registration confirmation code.
 * @returns {string} Confirmation code, e.g. `QPC-A1B2C3D4`
 */
function generateConfirmationCode() {
  return `QPC-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Load an event that is open for public registration.
 * Draft, cancelled and closed-import events are not registrable.
 *
 * @param {string} slug - Public event slug
 * @returns {Promise<Object>} The event record
 * @throws {NotFoundError} If the event does not exist
 * @throws {BadRequestError} If the event is not open for registration
 */
async function findOpenEventBySlug(slug) {
  const event = await prisma.event.findFirst({
    where: { slug, deletedAt: null },
  });

  if (!event) {
    throw new NotFoundError(msg.EVENT.NOT_FOUND);
  }

  if (!EVENT_OPEN_STATUSES.includes(event.status)) {
    throw new BadRequestError(msg.REGISTRATION.NOT_OPEN);
  }

  if (event.registrationMode === 'CLOSED_IMPORT') {
    throw new BadRequestError(msg.REGISTRATION.NOT_OPEN);
  }

  const now = new Date();
  if (event.registrationOpensAt && now < new Date(event.registrationOpensAt)) {
    throw new BadRequestError(msg.REGISTRATION.NOT_OPEN);
  }
  if (event.registrationClosesAt && now > new Date(event.registrationClosesAt)) {
    throw new BadRequestError(msg.REGISTRATION.NOT_OPEN);
  }

  return event;
}

/**
 * Verify event and ticket type capacity before confirming a registration.
 * Capacity is re-checked inside the creation transaction for atomicity.
 * The free endpoint also rejects paid ticket types and paid events.
 *
 * @param {Object} event - Event record
 * @param {string} [ticketTypeId] - Optional ticket type UUID
 * @returns {Promise<Object|null>} The validated ticket type, or null
 * @throws {BadRequestError} If capacity is exhausted or the ticket type is invalid
 */
async function assertCapacity(event, ticketTypeId) {
  if (event.capacity != null) {
    const registered = await prisma.registration.count({
      where: { eventId: event.id, status: { not: 'CANCELLED' } },
    });
    if (registered >= event.capacity) {
      throw new BadRequestError(msg.REGISTRATION.CAPACITY_EXCEEDED);
    }
  }

  if (!ticketTypeId) {
    if (event.isPaid) {
      throw new BadRequestError(msg.REGISTRATION.PAID_EVENT);
    }
    return null;
  }

  const ticketType = await prisma.ticketType.findFirst({
    where: { id: ticketTypeId, eventId: event.id, active: true },
  });

  if (!ticketType) {
    throw new BadRequestError(msg.REGISTRATION.INVALID_TICKET_TYPE);
  }

  if (ticketType.price > 0) {
    throw new BadRequestError(msg.REGISTRATION.PAID_TICKET_TYPE);
  }

  if (ticketType.capacity != null && ticketType.quantitySold >= ticketType.capacity) {
    throw new BadRequestError(msg.REGISTRATION.TICKET_TYPE_FULL);
  }

  return ticketType;
}

/**
 * Find an existing registration for an attendee on an event.
 * @param {string} eventId - UUID of the event
 * @param {string} email - Normalized attendee email
 * @returns {Promise<Object|null>} The existing registration record, or null
 */
async function assertNoDuplicate(eventId, email) {
  return prisma.registration.findUnique({
    where: { eventId_attendeeEmail: { eventId, attendeeEmail: email } },
  });
}

/**
 * Create the TicketCode + Registration records (CONFIRMED) for a free
 * public registration inside a transaction. Event capacity is enforced by
 * row-locking the event, and ticket type capacity by a guarded conditional
 * update, so concurrent registrations cannot oversell. Retries on
 * confirmation code collisions, but surfaces duplicate-email conflicts
 * immediately.
 *
 * @param {Object} event - Event record
 * @param {Object} data - { name, email, phone, ticketTypeId, metadata }
 * @returns {Promise<Object>} The created Registration record
 */
async function createFreeRegistration(event, { name, email, phone, ticketTypeId, metadata }) {
  let lastError;

  for (let attempt = 0; attempt < CONFIRMATION_CODE_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const eventRows = await tx.$queryRaw`
          SELECT "capacity" FROM "events" WHERE "id" = ${event.id} FOR UPDATE
        `;
        const capacity = eventRows[0]?.capacity ?? null;
        if (capacity != null) {
          const registered = await tx.registration.count({
            where: { eventId: event.id, status: { not: 'CANCELLED' } },
          });
          if (registered >= capacity) {
            throw new BadRequestError(msg.REGISTRATION.CAPACITY_EXCEEDED);
          }
        }

        if (ticketTypeId) {
          const ticketTypeGuard = await tx.$executeRaw`
            UPDATE "ticket_types"
            SET "quantity_sold" = "quantity_sold" + 1, "updated_at" = now()
            WHERE "id" = ${ticketTypeId}
              AND "active" = true
              AND ("capacity" IS NULL OR "quantity_sold" < "capacity")
          `;

          if (ticketTypeGuard === 0) {
            throw new BadRequestError(msg.REGISTRATION.TICKET_TYPE_FULL);
          }
        }

        const ticketCode = await tx.ticketCode.create({
          data: {
            eventId: event.id,
            code: generateTicketCode(event.id),
            status: 'USED',
            attendeeEmail: email,
            attendeeName: name,
          },
        });

        const registration = await tx.registration.create({
          data: {
            eventId: event.id,
            ticketCodeId: ticketCode.id,
            attendeeEmail: email,
            attendeeName: name,
            phone: phone || null,
            ticketTypeId: ticketTypeId || null,
            source: 'PUBLIC_LINK',
            status: 'CONFIRMED',
            paymentStatus: 'SUCCESS',
            confirmationCode: generateConfirmationCode(),
            metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
          },
        });

        return registration;
      });
    } catch (error) {
      if (error.code !== 'P2002') {
        throw error;
      }

      // A P2002 could be a duplicate (eventId, attendeeEmail) row or a
      // confirmation code collision — distinguish before deciding to retry.
      const duplicate = await prisma.registration.findUnique({
        where: { eventId_attendeeEmail: { eventId: event.id, attendeeEmail: email } },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictError(msg.REGISTRATION.DUPLICATE);
      }

      lastError = error;
    }
  }

  throw lastError;
}

/**
 * Issue a QR token for a registration and mark the registration as QR-issued.
 * If a token already exists (e.g. a previous issuance created the QrToken
 * before failing to mark qrIssued), it is reused so a retry can complete.
 *
 * @param {string} registrationId - UUID of the registration
 * @param {Object} event - Event record (endTime drives the QR expiry)
 * @returns {Promise<string>} The raw QR token delivered to the attendee
 */
async function issueQrToken(registrationId, event) {
  const expiresAt = new Date(
    new Date(event.endTime).getTime() + constants.QR.EXPIRY_HOURS * 60 * 60 * 1000
  );

  const existing = await prisma.qrToken.findUnique({ where: { registrationId } });
  const rawToken = existing
    ? await qrService.recoverRawToken(existing, event)
    : await qrService.generateToken(registrationId, expiresAt);

  await prisma.registration.update({
    where: { id: registrationId },
    data: { qrIssued: true, qrIssuedAt: new Date() },
  });

  return rawToken;
}

/**
 * Issue the QR token, send the confirmation + QR emails, write the audit log,
 * and shape the response for an already-created CONFIRMED registration.
 *
 * @param {Object} event - Event record
 * @param {Object} registration - CONFIRMED Registration record
 * @param {string} [ticketTypeName] - Name of the selected ticket type
 * @returns {Promise<Object>} { registration, qr: { token, image } }
 */
async function completeRegistration(event, registration, ticketTypeName) {
  const rawToken = await issueQrToken(registration.id, event);
  const qrImage = await qrService.createQrImage(rawToken);

  sendRegistrationEmails({
    event,
    registration,
    rawToken,
    qrImage,
    attendeeName: registration.attendeeName,
    attendeeEmail: registration.attendeeEmail,
    ticketTypeName,
  });
  await writeRegistrationAudit(registration, event);

  try {
    emitRegistrationNew(getIO(), event.id, {
      registrationId: registration.id,
      attendeeName: registration.attendeeName,
      attendeeEmail: registration.attendeeEmail,
      ticketTypeId: registration.ticketTypeId || null,
    });
  } catch (err) {
    logger.warn({ err, eventId: event.id }, 'failed to emit registration:new');
  }

  return {
    registration: publicRegistrationResponse({
      ...registration,
      qrIssued: true,
      qrIssuedAt: new Date(),
    }),
    qr: {
      token: rawToken,
      image: `data:image/png;base64,${qrImage.toString('base64')}`,
    },
  };
}

/**
 * Send the registration confirmation and QR emails. Fire-and-forget: email
 * failures must never block the registration response.
 *
 * @param {Object} options - { event, registration, rawToken, qrImage, attendeeName, attendeeEmail, ticketTypeName }
 */
function sendRegistrationEmails({
  event,
  registration,
  rawToken,
  qrImage,
  attendeeName,
  attendeeEmail,
  ticketTypeName,
}) {
  sendNotification({
    recipient: attendeeEmail,
    subject: `Registration Confirmed: ${event.title}`,
    template: 'registration',
    context: {
      name: attendeeName,
      email: attendeeEmail,
      eventTitle: event.title,
    },
    eventId: event.id,
    registrationId: registration.id,
  }).catch((err) => {
    logger.warn({ err: err.message, email: attendeeEmail }, 'Failed to send registration confirmation email');
  });

  const qrCodeUrl = `data:image/png;base64,${qrImage.toString('base64')}`;

  sendNotification({
    recipient: attendeeEmail,
    subject: `Your QR Ticket: ${event.title}`,
    template: 'qr-issued',
    context: {
      name: attendeeName,
      eventName: event.title,
      eventDate: new Date(event.startTime).toLocaleString(),
      ticketType: ticketTypeName,
      qrCodeUrl,
      qrData: rawToken,
    },
    eventId: event.id,
    registrationId: registration.id,
  }).catch((err) => {
    logger.warn({ err: err.message, email: attendeeEmail }, 'Failed to send QR email');
  });
}

/**
 * Write a public registration audit log entry. Non-fatal on failure.
 * @param {Object} registration - Registration record
 * @param {Object} event - Event record
 */
async function writeRegistrationAudit(registration, event) {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'PUBLIC_REGISTRATION',
        entity: 'Registration',
        entityId: registration.id,
        afterSnapshot: {
          eventId: event.id,
          attendeeEmail: registration.attendeeEmail,
          attendeeName: registration.attendeeName,
          ticketTypeId: registration.ticketTypeId,
          status: registration.status,
          confirmationCode: registration.confirmationCode,
        },
      },
    });
  } catch (err) {
    logger.warn({ err: err.message, registrationId: registration.id }, 'Failed to create registration audit log');
  }
}

/**
 * Shape a registration record for public API responses.
 * @param {Object} registration - Registration record
 * @returns {Object} Public-facing registration fields
 */
function publicRegistrationResponse(registration) {
  return {
    id: registration.id,
    eventId: registration.eventId,
    attendeeName: registration.attendeeName,
    attendeeEmail: registration.attendeeEmail,
    phone: registration.phone,
    ticketTypeId: registration.ticketTypeId,
    status: registration.status,
    paymentStatus: registration.paymentStatus,
    source: registration.source,
    confirmationCode: registration.confirmationCode,
    qrIssued: registration.qrIssued,
    qrIssuedAt: registration.qrIssuedAt,
    createdAt: registration.createdAt,
  };
}

/**
 * Get an open event by its public slug, including its active ticket types.
 * @param {string} slug - Public event slug
 * @returns {Promise<Object>} Event record with `ticketTypes`
 * @throws {NotFoundError} If the event is not found or not publicly viewable
 */
export async function getPublicEventBySlug(slug) {
  const event = await prisma.event.findFirst({
    where: {
      slug,
      deletedAt: null,
      status: { in: EVENT_OPEN_STATUSES },
    },
    include: {
      ticketTypes: {
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!event) {
    throw new NotFoundError(msg.EVENT.NOT_FOUND);
  }

  return event;
}

/**
 * Register an attendee for a free public event.
 *
 * Validates the event is open, checks capacity and duplicate email, then
 * creates a CONFIRMED registration with a QR token. Emails (confirmation +
 * QR) are fire-and-forget and never block the response. A retry for an
 * existing CONFIRMED registration that never got its QR (qrIssued false)
 * completes QR issuance instead of returning a duplicate conflict.
 *
 * @param {Object} data - { slug, name, email, phone?, ticketTypeId?, metadata? }
 * @returns {Promise<Object>} { registration, qr: { token, image } }
 * @throws {NotFoundError|BadRequestError|ConflictError} On validation failures
 */
export async function registerFree({ slug, name, email, phone, ticketTypeId, metadata }) {
  const attendeeName = (name || '').trim();
  const attendeeEmail = normalizeEmail(email);

  if (!attendeeName) {
    throw new BadRequestError(systemMessages.VALIDATION.NAME_REQUIRED);
  }
  if (!EMAIL_REGEX.test(attendeeEmail) || attendeeEmail.length > MAX_EMAIL_LENGTH) {
    throw new BadRequestError(systemMessages.VALIDATION.INVALID_EMAIL);
  }

  const event = await findOpenEventBySlug(slug);
  const ticketType = await assertCapacity(event, ticketTypeId);

  const existing = await assertNoDuplicate(event.id, attendeeEmail);
  if (existing) {
    if (existing.status === 'CONFIRMED' && !existing.qrIssued) {
      return completeRegistration(event, existing, ticketType?.name);
    }
    throw new ConflictError(msg.REGISTRATION.DUPLICATE);
  }

  const registration = await createFreeRegistration(event, {
    name: attendeeName,
    email: attendeeEmail,
    phone,
    ticketTypeId,
    metadata,
  });

  return completeRegistration(event, registration, ticketType?.name);
}

/**
 * Get a registration record by its unique ID.
 * @param {string} id - UUID of the registration
 * @returns {Promise<Object>} Registration record with related ticketCode and event
 * @throws {NotFoundError} If registration is not found
 */
export async function getRegistrationById(id) {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      ticketCode: true,
      event: true,
    },
  });

  if (!registration) {
    throw new NotFoundError('Registration not found');
  }

  return registration;
}

/**
 * Get a registration by attendee email within an event.
 * @param {string} eventId - UUID of the event
 * @param {string} email - Attendee email
 * @returns {Promise<Object|null>} Matching registration record or null
 */
export async function getRegistrationByEmail(eventId, email) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  return prisma.registration.findFirst({
    where: {
      eventId,
      attendeeEmail: normalizedEmail,
    },
    include: {
      ticketCode: true,
    },
  });
}

/**
 * List registrations for an event with pagination and optional filters.
 * @param {string} eventId - UUID of the event
 * @param {number} [page=1] - 1-indexed page number
 * @param {number} [limit=20] - Items per page
 * @param {Object} [filters={}] - Optional filters (status, paymentStatus)
 * @returns {Promise<Object>} Paginated result { registrations, pagination }
 */
const MAX_PAGE_SIZE = 100;

export async function listRegistrationsByEvent(eventId, page = 1, limit = 20, filters = {}, unbounded = false) {
  const take = unbounded ? Math.max(1, Number(limit) || 20) : Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const skip = (currentPage - 1) * take;

  const where = { eventId };
  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.paymentStatus) {
    where.paymentStatus = filters.paymentStatus;
  }

  const [registrations, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        ticketCode: true,
        ticketType: true,
      },
    }),
    prisma.registration.count({
      where,
    }),
  ]);

  return {
    registrations,
    pagination: {
      page: currentPage,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
    },
  };
}
