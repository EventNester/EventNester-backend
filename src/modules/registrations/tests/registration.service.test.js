import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPublicEventBySlug,
  registerFree,
  getRegistrationById,
  getRegistrationByEmail,
  listRegistrationsByEvent,
} from '../registration.service.js';
import prisma from '../../../database/index.js';
import {
  NotFoundError,
  ConflictError,
} from '../../../utils/error.js';
import { qrService } from '../../tickets/qr.service.js';
import { sendNotification } from '../../notifications/notification.service.js';

vi.mock('../../../config/index.js', () => ({
  constants: {
    EVENT_STATUS: { PUBLISHED: 'PUBLISHED', ACTIVE: 'ACTIVE' },
    QR: { EXPIRY_HOURS: 24 },
  },
  systemMessages: {
    ERROR: {
      EVENT: { NOT_FOUND: 'Event not found' },
      REGISTRATION: {
        NOT_OPEN: 'Event is not open for registration',
        DUPLICATE: 'You have already registered for this event',
        CAPACITY_EXCEEDED: 'Event has reached full capacity',
        TICKET_TYPE_FULL: 'This ticket type has sold out',
        INVALID_TICKET_TYPE: 'Invalid or inactive ticket type',
        PAID_TICKET_TYPE: 'Paid ticket types are not allowed on the free registration endpoint',
        PAID_EVENT: 'This is a paid event and cannot use the free registration endpoint',
      },
    },
    VALIDATION: {
      NAME_REQUIRED: 'Name is required',
      INVALID_EMAIL: 'Invalid email address',
    },
  },
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../database/index.js', () => {
  const mPrisma = {
    event: { findFirst: vi.fn(), findUnique: vi.fn() },
    registration: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    ticketType: { findFirst: vi.fn() },
    ticketCode: { create: vi.fn() },
    qrToken: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn((cb) => cb(mPrisma)),
  };
  return { default: mPrisma };
});

vi.mock('../../tickets/qr.service.js', () => ({
  qrService: {
    generateToken: vi.fn(),
    recoverRawToken: vi.fn(),
    createQrImage: vi.fn(),
  },
}));

vi.mock('../../notifications/notification.service.js', () => ({
  sendNotification: vi.fn().mockResolvedValue({ success: true }),
}));

describe('Registration Service', () => {
  const eventId = 'event-1';
  const attendeeEmail = 'ada@example.com';

  const baseEvent = {
    id: eventId,
    slug: 'tech-summit',
    title: 'Tech Summit',
    status: 'PUBLISHED',
    registrationMode: 'OPEN',
    isPaid: false,
    capacity: null,
    registrationOpensAt: null,
    registrationClosesAt: null,
    startTime: new Date('2026-08-15T09:00:00Z'),
    endTime: new Date('2026-08-15T17:00:00Z'),
    ownerId: 'owner-1',
    deletedAt: null,
  };

  const baseRegistration = {
    id: 'reg-1',
    eventId,
    attendeeEmail,
    attendeeName: 'Ada Lovelace',
    phone: null,
    ticketTypeId: null,
    status: 'CONFIRMED',
    paymentStatus: 'SUCCESS',
    source: 'PUBLIC_LINK',
    confirmationCode: 'QPC-ABC123',
    qrIssued: true,
    qrIssuedAt: new Date(),
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.event.findFirst.mockResolvedValue(baseEvent);
    prisma.registration.findUnique.mockResolvedValue(null);
    prisma.qrToken.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ capacity: null }]);
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.ticketCode.create.mockResolvedValue({ id: 'tc-1' });
    prisma.registration.create.mockImplementation(async ({ data }) => ({
      id: 'reg-new',
      ...data,
      confirmationCode: 'QPC-NEW123',
    }));
    prisma.registration.update.mockImplementation(async ({ data }) => ({
      ...baseRegistration,
      ...data,
    }));
    prisma.auditLog.create.mockResolvedValue({});
    qrService.generateToken.mockResolvedValue('raw-token');
    qrService.createQrImage.mockResolvedValue(Buffer.from('png'));
    sendNotification.mockResolvedValue({ success: true });
  });

  describe('getPublicEventBySlug', () => {
    it('returns the event with active ticket types', async () => {
      const eventWithTypes = {
        ...baseEvent,
        ticketTypes: [{ id: 'tt-1', name: 'VIP', active: true, sortOrder: 0 }],
      };
      prisma.event.findFirst.mockResolvedValue(eventWithTypes);

      const result = await getPublicEventBySlug('tech-summit');
      expect(result).toEqual(eventWithTypes);
      expect(prisma.event.findFirst).toHaveBeenCalledWith({
        where: {
          slug: 'tech-summit',
          deletedAt: null,
          status: { in: ['PUBLISHED', 'ACTIVE'] },
        },
        include: {
          ticketTypes: {
            where: { active: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
    });

    it('throws NotFoundError when the slug is unknown', async () => {
      prisma.event.findFirst.mockResolvedValue(null);
      await expect(getPublicEventBySlug('nope')).rejects.toThrow(NotFoundError);
    });
  });

  describe('registerFree validation', () => {
    it('throws BadRequestError when name is empty', async () => {
      await expect(
        registerFree({ slug: 'tech-summit', name: '   ', email: attendeeEmail })
      ).rejects.toThrow('Name is required');
    });

    it('throws BadRequestError when email is malformed', async () => {
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: 'not-an-email' })
      ).rejects.toThrow('Invalid email address');
    });

    it('throws BadRequestError when email exceeds 254 characters', async () => {
      await expect(
        registerFree({
          slug: 'tech-summit',
          name: 'Ada',
          email: 'a'.repeat(250) + '@example.com',
        })
      ).rejects.toThrow('Invalid email address');
    });

    it('throws NotFoundError when the event does not exist', async () => {
      prisma.event.findFirst.mockResolvedValue(null);
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow(NotFoundError);
    });

    it('throws BadRequestError when event status is not open', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...baseEvent, status: 'DRAFT' });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('Event is not open for registration');
    });

    it('throws BadRequestError when registration mode is CLOSED_IMPORT', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...baseEvent, registrationMode: 'CLOSED_IMPORT' });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('Event is not open for registration');
    });

    it('throws BadRequestError when registration has not opened yet', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...baseEvent,
        registrationOpensAt: new Date(Date.now() + 60_000),
      });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('Event is not open for registration');
    });

    it('throws BadRequestError when registration window has closed', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...baseEvent,
        registrationClosesAt: new Date(Date.now() - 60_000),
      });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('Event is not open for registration');
    });
  });

  describe('registerFree capacity & ticket type', () => {
    it('throws BadRequestError when event capacity is reached', async () => {
      prisma.$queryRaw.mockResolvedValue([{ capacity: 5 }]);
      prisma.registration.count.mockResolvedValue(5);
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('Event has reached full capacity');
    });

    it('throws BadRequestError for a paid event without a ticket type', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...baseEvent, isPaid: true });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('This is a paid event and cannot use the free registration endpoint');
    });

    it('throws BadRequestError for an invalid ticket type', async () => {
      prisma.ticketType.findFirst.mockResolvedValue(null);
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail, ticketTypeId: 'tt-bad' })
      ).rejects.toThrow('Invalid or inactive ticket type');
    });

    it('throws BadRequestError for a paid ticket type', async () => {
      prisma.ticketType.findFirst.mockResolvedValue({ id: 'tt-paid', price: 500, capacity: null, quantitySold: 0 });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail, ticketTypeId: 'tt-paid' })
      ).rejects.toThrow('Paid ticket types are not allowed on the free registration endpoint');
    });

    it('throws BadRequestError when a ticket type has sold out', async () => {
      prisma.ticketType.findFirst.mockResolvedValue({ id: 'tt-full', price: 0, capacity: 5, quantitySold: 5 });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail, ticketTypeId: 'tt-full' })
      ).rejects.toThrow('This ticket type has sold out');
    });

    it('throws BadRequestError when the ticket type guard rejects the upsell', async () => {
      prisma.ticketType.findFirst.mockResolvedValue({ id: 'tt-ok', price: 0, capacity: 5, quantitySold: 0 });
      prisma.$executeRaw.mockResolvedValue(0);
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail, ticketTypeId: 'tt-ok' })
      ).rejects.toThrow('This ticket type has sold out');
    });
  });

  describe('registerFree duplicate handling', () => {
    it('throws ConflictError when a CONFIRMED registration with QR already exists', async () => {
      prisma.registration.findUnique.mockResolvedValue({ ...baseRegistration, qrIssued: true });
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow(ConflictError);
      expect(qrService.generateToken).not.toHaveBeenCalled();
    });

    it('completes QR issuance for a CONFIRMED registration that never got its QR', async () => {
      const pendingQr = { ...baseRegistration, qrIssued: false, id: 'reg-existing' };
      prisma.registration.findUnique.mockResolvedValue(pendingQr);
      prisma.qrToken.findUnique.mockResolvedValue({ id: 'qr-existing', tokenHash: 'existing-hash', tokenCipher: 'existing-cipher' });
      qrService.recoverRawToken.mockResolvedValue('existing-raw-token');

      const result = await registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail });

      expect(result.qr.token).toBe('existing-raw-token');
      expect(result.registration.id).toBe('reg-existing');
      expect(qrService.recoverRawToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'qr-existing' }),
        expect.objectContaining({ id: eventId })
      );
      expect(qrService.generateToken).not.toHaveBeenCalled();
      expect(prisma.registration.update).toHaveBeenCalledWith({
        where: { id: 'reg-existing' },
        data: expect.objectContaining({ qrIssued: true, qrIssuedAt: expect.any(Date) }),
      });
    });
  });

  describe('registerFree success path', () => {
    it('creates a registration, issues QR, and sends emails', async () => {
      const result = await registerFree({
        slug: 'tech-summit',
        name: '  Ada Lovelace  ',
        email: '  ADA@example.com  ',
        phone: '+234',
      });

      expect(prisma.registration.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId,
          ticketCodeId: 'tc-1',
          attendeeEmail: 'ada@example.com',
          attendeeName: 'Ada Lovelace',
          phone: '+234',
          source: 'PUBLIC_LINK',
          status: 'CONFIRMED',
          paymentStatus: 'SUCCESS',
          confirmationCode: expect.stringMatching(/^QPC-/),
        }),
      });
      expect(qrService.generateToken).toHaveBeenCalledWith(
        'reg-new',
        expect.any(Date)
      );
      expect(result.registration.attendeeEmail).toBe('ada@example.com');
      expect(result.registration.qrIssued).toBe(true);
      expect(result.qr.token).toBe('raw-token');
      expect(result.qr.image).toMatch(/^data:image\/png;base64,/);
      expect(sendNotification).toHaveBeenCalledTimes(2);
    });

    it('issues a new token when no QR token exists yet', async () => {
      prisma.qrToken.findUnique.mockResolvedValue(null);
      qrService.generateToken.mockResolvedValue('brand-new-token');

      const result = await registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail });
      expect(result.qr.token).toBe('brand-new-token');
      expect(qrService.generateToken).toHaveBeenCalled();
    });

    it('does not fail when email sending fails (fire-and-forget)', async () => {
      sendNotification.mockRejectedValue(new Error('Email not sent'));
      const result = await registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail });
      expect(result.registration).toBeDefined();
    });

    it('does not fail when audit log creation fails', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('DB error'));
      const result = await registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail });
      expect(result.registration).toBeDefined();
    });
  });

  describe('createFreeRegistration retries', () => {
    it('retries on P2002 when it is not a duplicate email', async () => {
      prisma.$transaction
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementationOnce(async (cb) => cb(prisma));

      prisma.registration.create.mockImplementation(async ({ data }) => ({
        id: 'reg-after-retry',
        ...data,
        confirmationCode: 'QPC-RETRY',
      }));

      const result = await registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail });
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(result.registration.id).toBe('reg-after-retry');
    });

    it('throws ConflictError on P2002 that is a duplicate email', async () => {
      prisma.$transaction.mockRejectedValue({ code: 'P2002' });
      prisma.registration.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow(ConflictError);
    });

    it('throws non-P2002 errors immediately', async () => {
      prisma.$transaction.mockRejectedValue(new Error('DB timeout'));
      await expect(
        registerFree({ slug: 'tech-summit', name: 'Ada', email: attendeeEmail })
      ).rejects.toThrow('DB timeout');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRegistrationById', () => {
    it('returns the registration with relations', async () => {
      prisma.registration.findUnique.mockResolvedValue(baseRegistration);
      const result = await getRegistrationById('reg-1');
      expect(result).toEqual(baseRegistration);
      expect(prisma.registration.findUnique).toHaveBeenCalledWith({
        where: { id: 'reg-1' },
        include: { ticketCode: true, event: true },
      });
    });

    it('throws NotFoundError when missing', async () => {
      prisma.registration.findUnique.mockResolvedValue(null);
      await expect(getRegistrationById('nope')).rejects.toThrow('Registration not found');
    });
  });

  describe('getRegistrationByEmail', () => {
    it('normalizes the email and returns the registration', async () => {
      prisma.registration.findFirst.mockResolvedValue(baseRegistration);
      const result = await getRegistrationByEmail(eventId, '  ADA@example.com  ');
      expect(result).toEqual(baseRegistration);
      expect(prisma.registration.findFirst).toHaveBeenCalledWith({
        where: { eventId, attendeeEmail: 'ada@example.com' },
        include: { ticketCode: true },
      });
    });

    it('returns null when nothing matches', async () => {
      prisma.registration.findFirst.mockResolvedValue(null);
      expect(await getRegistrationByEmail(eventId, 'nobody@example.com')).toBeNull();
    });
  });

  describe('listRegistrationsByEvent', () => {
    const rows = [{ id: 'r1', attendeeEmail: 'a@example.com' }, { id: 'r2', attendeeEmail: 'b@example.com' }];

    it('returns paginated registrations with defaults', async () => {
      prisma.registration.findMany.mockResolvedValue(rows);
      prisma.registration.count.mockResolvedValue(2);

      const result = await listRegistrationsByEvent(eventId);
      expect(result.registrations).toEqual(rows);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('applies status and paymentStatus filters', async () => {
      prisma.registration.findMany.mockResolvedValue([]);
      prisma.registration.count.mockResolvedValue(0);

      await listRegistrationsByEvent(eventId, 2, 10, { status: 'CONFIRMED', paymentStatus: 'SUCCESS' });
      expect(prisma.registration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId, status: 'CONFIRMED', paymentStatus: 'SUCCESS' },
          skip: 10,
          take: 10,
        })
      );
    });

    it('clamps limit to MAX_PAGE_SIZE and floors page at 1', async () => {
      prisma.registration.findMany.mockResolvedValue([]);
      prisma.registration.count.mockResolvedValue(0);

      const result = await listRegistrationsByEvent(eventId, 0, 9999);
      expect(result.pagination.limit).toBe(100);
      expect(result.pagination.page).toBe(1);
    });

    it('supports unbounded take for exports', async () => {
      prisma.registration.findMany.mockResolvedValue([]);
      prisma.registration.count.mockResolvedValue(0);

      const result = await listRegistrationsByEvent(eventId, 1, 500, {}, true);
      expect(result.pagination.limit).toBe(500);
    });
  });
});
