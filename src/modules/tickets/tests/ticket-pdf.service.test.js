import { describe, it, expect, vi, beforeEach } from 'vitest';

const pdfMock = vi.hoisted(() => {
  const docs = [];
  const settings = { rowHeight: 12 };
  const createMockDoc = vi.fn(() => {
    const listeners = {};
    const doc = {
      fontSize: vi.fn().mockReturnThis(),
      font: vi.fn().mockReturnThis(),
      text: vi.fn().mockReturnThis(),
      moveDown: vi.fn().mockReturnThis(),
      moveTo: vi.fn().mockReturnThis(),
      lineTo: vi.fn().mockReturnThis(),
      strokeColor: vi.fn().mockReturnThis(),
      stroke: vi.fn().mockReturnThis(),
      image: vi.fn().mockReturnThis(),
      fillColor: vi.fn().mockReturnThis(),
      heightOfString: vi.fn(() => settings.rowHeight),
      addPage: vi.fn().mockReturnThis(),
      pipe: vi.fn().mockReturnThis(),
      y: 40,
      page: { width: 595 },
      on: vi.fn(function (event, cb) {
        listeners[event] = cb;
        return this;
      }),
      end: vi.fn(function () {
        if (listeners.data) listeners.data(Buffer.from('mock-pdf-bytes'));
        if (listeners.end) listeners.end();
        return this;
      }),
    };
    docs.push(doc);
    return doc;
  });
  return { docs, settings, createMockDoc };
});

vi.mock('pdfkit', () => ({
  default: vi.fn(function () {
    return pdfMock.createMockDoc();
  }),
}));

vi.mock('qrcode', () => ({
  default: {
    toBuffer: vi.fn(),
  },
}));

vi.mock('../../../database/index.js', () => ({
  default: {
    registration: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    qrToken: {
      update: vi.fn(),
    },
  },
}));

import {
  generateTicketPdf,
  generateIndividualTicketPdf,
  generateTicketListPdf,
} from '../ticket-pdf.service.js';
import prisma from '../../../database/index.js';
import { qrService } from '../qr.service.js';
import { NotFoundError, ForbiddenError } from '../../../utils/error.js';

const OWNER_USER = 'owner-user-id';
const ATTENDEE_USER = 'attendee-user-id';
const ATTENDEE_EMAIL = 'test@example.com';
const STRANGER_USER = 'stranger-user-id';

function lastDoc() {
  return pdfMock.docs[pdfMock.docs.length - 1];
}

function buildMockRegistration(overrides = {}) {
  return {
    id: 'reg-1',
    attendeeEmail: ATTENDEE_EMAIL,
    attendeeName: overrides.attendeeName ?? 'Ada Lovelace',
    phone: '+2348012345678',
    status: 'CONFIRMED',
    paymentStatus: 'SUCCESS',
    confirmationCode: 'CNF-ABC-123',
    qrIssued: true,
    qrIssuedAt: new Date(),
    createdAt: new Date(),
    event: {
      ownerId: OWNER_USER,
      deletedAt: null,
      title: 'Tech Summit 2026',
      startTime: new Date('2026-08-15T09:00:00Z'),
      endTime: new Date('2026-08-15T17:00:00Z'),
      venue: 'Eko Convention Centre, Lagos',
      slug: 'tech-summit-2026',
    },
    ticketCode: {
      code: 'TICKET-001',
    },
    ticketType: {
      name: 'VIP',
    },
    qrToken: {
      id: 'qr-1',
      tokenHash: 'abc123def456',
    },
    ...overrides,
  };
}

describe('generateTicketPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(qrService, 'recoverRawToken').mockResolvedValue('raw-scan-token');
  });

  it('should return a PDFDocument stream for event owner', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
    expect(doc.end).toBeDefined();
    expect(doc.fontSize).toBeDefined();
  });

  it('should render the event title, attendee name, and ticket type', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    const textCalls = doc.text.mock.calls.map((c) => c[0]);
    expect(textCalls).toContain('Tech Summit 2026');
    expect(textCalls).toContain('Ada Lovelace');
    expect(textCalls).toContain('Ticket Type: VIP');
    expect(textCalls).toContain(`Email: ${ATTENDEE_EMAIL}`);
    expect(textCalls).toContain('Confirmation Code: CNF-ABC-123');
  });

  it('should embed the QR image encoding the raw scan token when a qrToken exists', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(qrService.recoverRawToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'qr-1' }),
      expect.objectContaining({ ownerId: OWNER_USER })
    );
    expect(qrService.createQrImage).toHaveBeenCalledWith('raw-scan-token', { width: 150 });
    expect(doc.image).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(Number),
      expect.any(Number),
      { width: 150, height: 150 }
    );
  });

  it('should return a PDFDocument stream for registration attendee', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    prisma.user.findUnique.mockResolvedValue({ id: ATTENDEE_USER, email: ATTENDEE_EMAIL });
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', ATTENDEE_USER);
    expect(doc).toBeDefined();
  });

  it('should throw NotFoundError when registration does not exist', async () => {
    prisma.registration.findUnique.mockResolvedValue(null);
    await expect(generateTicketPdf('nonexistent', OWNER_USER)).rejects.toThrow(NotFoundError);
  });

  it('should throw NotFoundError when the event is soft-deleted', async () => {
    prisma.registration.findUnique.mockResolvedValue(
      buildMockRegistration({ event: { ...buildMockRegistration().event, deletedAt: new Date() } })
    );
    await expect(generateTicketPdf('reg-1', OWNER_USER)).rejects.toThrow(NotFoundError);
  });

  it('should throw ForbiddenError for a stranger', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    prisma.user.findUnique.mockResolvedValue({ id: STRANGER_USER, email: 'stranger@evil.com' });

    await expect(generateTicketPdf('reg-1', STRANGER_USER)).rejects.toThrow(ForbiddenError);
  });

  it('should throw ForbiddenError when user lookup fails', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(generateTicketPdf('reg-1', STRANGER_USER)).rejects.toThrow(ForbiddenError);
  });

  it('should handle long attendee names without error', async () => {
    const longName = 'Chief Dr. Sir Chukwudi Emmanuel Okafor-Mbah of Anambra State Kingdom';
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration({ attendeeName: longName }));
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
  });

  it('should handle special characters in attendee name', async () => {
    const specialName = 'José Martínez-González ñuñoa Pérez übel';
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration({ attendeeName: specialName }));
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
  });

  it('should handle missing qrToken gracefully (fallback text)', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration({ qrToken: null }));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
    expect(doc.image).not.toHaveBeenCalled();
    expect(
      doc.text.mock.calls.map((c) => c[0])
    ).toContain('QR code unavailable for this ticket');
  });

  it('should handle QR image generation failure gracefully (fallback text)', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration());
    vi.spyOn(qrService, 'createQrImage').mockRejectedValue(new Error('QR generation failed'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
    expect(
      doc.text.mock.calls.map((c) => c[0])
    ).toContain('QR code unavailable for this ticket');
  });

  it('should handle null phone number', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration({ phone: null }));
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
  });

  it('should handle null ticket type (defaults to General)', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration({ ticketType: null }));
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    const textCalls = doc.text.mock.calls.map((c) => c[0]);
    expect(textCalls).toContain('Ticket Type: General');
  });

  it('should handle null confirmation code', async () => {
    prisma.registration.findUnique.mockResolvedValue(buildMockRegistration({ confirmationCode: null }));
    vi.spyOn(qrService, 'createQrImage').mockResolvedValue(Buffer.from('mock-png'));

    const doc = await generateTicketPdf('reg-1', OWNER_USER);
    expect(doc).toBeDefined();
  });
});

describe('generateIndividualTicketPdf', () => {
  it('resolves a PDF buffer with event, attendee, and ticket details', async () => {
    const buffer = await generateIndividualTicketPdf(buildMockRegistration(), 'data:image/png;base64,aGVsbG8=');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe('mock-pdf-bytes');
  });

  it('renders the event name and attendee information text', async () => {
    await generateIndividualTicketPdf(buildMockRegistration(), null);

    const textCalls = lastDoc().text.mock.calls.map((c) => c[0]);
    expect(textCalls).toContain('QPass Ticket');
    expect(textCalls).toContain('Tech Summit 2026');
    expect(textCalls).toContain('Name: Ada Lovelace');
    expect(textCalls).toContain('Email: test@example.com');
    expect(textCalls).toContain('Ticket Type: VIP');
    expect(textCalls).toContain('Status: CONFIRMED');
  });

  it('embeds the QR image when a data URL is provided', async () => {
    await generateIndividualTicketPdf(buildMockRegistration(), 'data:image/png;base64,cG5nLWltYWdl');

    expect(lastDoc().image).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ fit: [150, 150], align: 'center', valign: 'center' })
    );
  });

  it('does not embed a QR image when the data URL is missing', async () => {
    await generateIndividualTicketPdf(buildMockRegistration(), null);
    expect(lastDoc().image).not.toHaveBeenCalled();
  });

  it('rejects when PDFKit construction throws', async () => {
    pdfMock.createMockDoc.mockImplementationOnce(() => {
      throw new Error('pdfkit failure');
    });

    await expect(
      generateIndividualTicketPdf(buildMockRegistration(), null)
    ).rejects.toThrow('pdfkit failure');
  });
});

describe('generateTicketListPdf', () => {
  const registrations = [
    buildMockRegistration({ id: 'r1', attendeeName: 'Ada Lovelace', status: 'CONFIRMED', paymentStatus: 'SUCCESS' }),
    buildMockRegistration({ id: 'r2', attendeeName: 'Grace Hopper', ticketType: { name: 'General' } }),
  ];
  const event = buildMockRegistration().event;

  it('resolves a PDF buffer for a list of tickets', async () => {
    const buffer = await generateTicketListPdf(registrations, event);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe('mock-pdf-bytes');
  });

  it('renders the event title and table headers', async () => {
    await generateTicketListPdf(registrations, event);

    const textCalls = lastDoc().text.mock.calls.map((c) => c[0]);
    expect(textCalls).toContain('Ticket List: Tech Summit 2026');
    expect(textCalls).toContain('Name');
    expect(textCalls).toContain('Email');
    expect(textCalls).toContain('Ticket Type');
    expect(textCalls).toContain('Status');
    expect(textCalls).toContain('Payment');
    expect(textCalls).toContain('Ticket Code');
    expect(textCalls).toContain('Ada Lovelace');
    expect(textCalls).toContain('test@example.com');
    expect(textCalls).toContain('VIP');
    expect(textCalls).toContain('Grace Hopper');
  });

  it('falls back to N/A for missing cells', async () => {
    await generateTicketListPdf(
      [{ attendeeName: null, ticketType: null, status: null, paymentStatus: null, ticketCode: null }],
      event
    );

    const textCalls = lastDoc().text.mock.calls.map((c) => c[0]);
    expect(textCalls).toContain('N/A');
  });

  it('adds a new page when a row exceeds the page bottom limit', async () => {
    pdfMock.settings.rowHeight = 600;
    try {
      await generateTicketListPdf(registrations, event);
    } finally {
      pdfMock.settings.rowHeight = 12;
    }

    expect(lastDoc().addPage).toHaveBeenCalled();
  });

  it('rejects when PDFKit construction throws', async () => {
    pdfMock.createMockDoc.mockImplementationOnce(() => {
      throw new Error('pdfkit failure');
    });

    await expect(generateTicketListPdf(registrations, event)).rejects.toThrow('pdfkit failure');
  });
});
