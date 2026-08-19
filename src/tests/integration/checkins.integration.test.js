import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';
import app from '../../app.js';
import prisma from '../../database/index.js';
import { hashToken } from '../../utils/crypto.js';
import { cleanDatabase } from '../helpers/cleanup.js';

vi.mock('../../middlewares/rate-limit.middleware.js', () => ({
  globalLimiter: (_req, _res, next) => next(),
  authLimiter: (_req, _res, next) => next(),
}));

describe('Checkins API Integration Tests', () => {
  let organizerToken;
  let staffToken;
  let staffUserId;
  let eventId;
  let rawToken;
  let checkinId;
  const futureDate = new Date(Date.now() + 86400000);
  const laterDate = new Date(Date.now() + 172800000);

  beforeAll(async () => {
    await cleanDatabase();

    const orgReg = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Checkin Organizer',
        email: 'checkin-org@example.com',
        password: 'SecurePassword123',
        role: 'ORGANIZER',
      });

    organizerToken = orgReg.body.data.accessToken;

    const staffReg = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Checkin Staff',
        email: 'checkin-staff@example.com',
        password: 'SecurePassword123',
        role: 'STAFF',
      });

    staffToken = staffReg.body.data.accessToken;
    staffUserId = staffReg.body.data.user.id;

    const eventRes = await request(app)
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'Checkin Test Event',
        description: 'For checkin testing',
        venue: 'Checkin Venue',
        startTime: futureDate.toISOString(),
        endTime: laterDate.toISOString(),
      });

    eventId = eventRes.body.data.id;

    const ticketRes = await request(app)
      .post(`/api/v1/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'General', price: 0 });

    const ticketTypeId = ticketRes.body.data.id;

    const ticketCode = await prisma.ticketCode.create({
      data: {
        eventId,
        code: `TICKET-${randomBytes(4).toString('hex').toUpperCase()}`,
        attendeeEmail: 'attendee@example.com',
        attendeeName: 'Test Attendee',
      },
    });

    const registration = await prisma.registration.create({
      data: {
        eventId,
        ticketCodeId: ticketCode.id,
        attendeeEmail: 'attendee@example.com',
        attendeeName: 'Test Attendee',
        ticketTypeId,
        source: 'IMPORT',
        status: 'CONFIRMED',
        confirmationCode: `CONF-${randomBytes(4).toString('hex').toUpperCase()}`,
      },
    });

    rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    await prisma.qrToken.create({
      data: {
        registrationId: registration.id,
        tokenHash,
        expiresAt: new Date(laterDate.getTime() + 86400000),
      },
    });
  });


  describe('POST /api/v1/checkins/:eventId/scan', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .send({ token: rawToken });

      expect(response.status).toBe(401);
    });

    it('should return 403 for attendee role', async () => {
      const attendeeReg = await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: 'Plain Attendee',
          email: 'plain-attendee@example.com',
          password: 'SecurePassword123',
        });

      const attendeeToken = attendeeReg.body.data.accessToken;

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({ token: rawToken });

      expect(response.status).toBe(403);
    });

    it('should return 422 for missing token', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({});

      expect(response.status).toBe(422);
      expect(response.body.status).toBe('error');
    });

    it('should return 200 with VALID result for a valid scan', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ token: rawToken, deviceInfo: 'iPhone 15' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.result).toBe('VALID');
      expect(response.body.data.attendeeName).toBe('Test Attendee');
      expect(response.body.data.checkinId).toBeDefined();

      checkinId = response.body.data.checkinId;
    });

    it('should return 200 with REVOKED result for second scan of consumed QR', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ token: rawToken });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.result).toBe('REVOKED');
    });

    it('should return 200 with INVALID result for unknown token', async () => {
      const fakeToken = randomBytes(32).toString('hex');

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ token: fakeToken });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.result).toBe('INVALID');
    });

    it('should return 200 with EXPIRED result for an expired QR token', async () => {
      const expiredTicketCode = await prisma.ticketCode.create({
        data: {
          eventId,
          code: `TICKET-${randomBytes(4).toString('hex').toUpperCase()}`,
          attendeeEmail: 'expired@example.com',
          attendeeName: 'Expired Attendee',
        },
      });

      const expiredReg = await prisma.registration.create({
        data: {
          eventId,
          ticketCodeId: expiredTicketCode.id,
          attendeeEmail: 'expired@example.com',
          attendeeName: 'Expired Attendee',
          source: 'IMPORT',
          status: 'CONFIRMED',
        },
      });

      const expiredRawToken = randomBytes(32).toString('hex');

      await prisma.qrToken.create({
        data: {
          registrationId: expiredReg.id,
          tokenHash: hashToken(expiredRawToken),
          expiresAt: new Date(Date.now() - 60000),
        },
      });

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ token: expiredRawToken });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.result).toBe('EXPIRED');
    });

    it('should return 200 with WRONG_EVENT result for wrong event', async () => {
      const wrongEventRes = await request(app)
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'Wrong Event',
          startTime: futureDate.toISOString(),
          endTime: laterDate.toISOString(),
        });

      const wrongEventId = wrongEventRes.body.data.id;

      const otherRawToken = randomBytes(32).toString('hex');
      const otherHash = hashToken(otherRawToken);

      const otherTicketCode = await prisma.ticketCode.create({
        data: {
          eventId: wrongEventId,
          code: `TICKET-${randomBytes(4).toString('hex').toUpperCase()}`,
          attendeeEmail: 'wrong@example.com',
          attendeeName: 'Wrong Event Attendee',
        },
      });

      const otherReg = await prisma.registration.create({
        data: {
          eventId: wrongEventId,
          ticketCodeId: otherTicketCode.id,
          attendeeEmail: 'wrong@example.com',
          attendeeName: 'Wrong Event Attendee',
          source: 'IMPORT',
          status: 'CONFIRMED',
        },
      });

      await prisma.qrToken.create({
        data: {
          registrationId: otherReg.id,
          tokenHash: otherHash,
          expiresAt: new Date(laterDate.getTime() + 86400000),
        },
      });

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ token: otherRawToken });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.result).toBe('WRONG_EVENT');
    });

    it('should return 403 for staff not assigned to the event', async () => {
      const unassignedReg = await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: 'Unassigned Staff',
          email: 'unassigned-staff@example.com',
          password: 'SecurePassword123',
          role: 'STAFF',
        });

      const unassignedToken = unassignedReg.body.data.accessToken;

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${unassignedToken}`)
        .send({ token: rawToken });

      expect(response.status).toBe(403);
      expect(response.body.status).toBe('error');
    });

    it('should allow staff to scan', async () => {
      const freshReg = await prisma.registration.create({
        data: {
          eventId,
          ticketCodeId: (
            await prisma.ticketCode.create({
              data: {
                eventId,
                code: `TICKET-${randomBytes(4).toString('hex').toUpperCase()}`,
                attendeeEmail: 'staff-scan@example.com',
                attendeeName: 'Staff Scan Attendee',
              },
            })
          ).id,
          attendeeEmail: 'staff-scan@example.com',
          attendeeName: 'Staff Scan Attendee',
          source: 'IMPORT',
          status: 'CONFIRMED',
        },
      });

      const staffRawToken = randomBytes(32).toString('hex');
      const staffHash = hashToken(staffRawToken);

      await prisma.qrToken.create({
        data: {
          registrationId: freshReg.id,
          tokenHash: staffHash,
          expiresAt: new Date(laterDate.getTime() + 86400000),
        },
      });

      await prisma.eventStaffAssignment.create({
        data: { eventId, userId: staffUserId, permissionScope: 'SCANNER' },
      });

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ token: staffRawToken });

      expect(response.status).toBe(200);
      expect(response.body.data.result).toBe('VALID');
    });
  });

  describe('GET /api/v1/checkins/:eventId/checkins', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/checkins`);

      expect(response.status).toBe(401);
    });

    it('should return 200 with checkin list', async () => {
      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/checkins`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data[0].registration).toBeDefined();
      expect(response.body.data[0].staff).toBeDefined();
    });
  });

  describe('GET /api/v1/checkins/:eventId/attendees', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/attendees`);

      expect(response.status).toBe(401);
    });

    it('should return 403 for attendee role', async () => {
      const attendeeReg = await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: 'Lookup Attendee',
          email: 'lookup-attendee@example.com',
          password: 'SecurePassword123',
        });

      const token = attendeeReg.body.data.accessToken;

      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/attendees`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });

    it('should return 403 for unassigned staff', async () => {
      const unassignedReg = await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: 'Unassigned Lookup Staff',
          email: 'unassigned-lookup-staff@example.com',
          password: 'SecurePassword123',
          role: 'STAFF',
        });

      const token = unassignedReg.body.data.accessToken;

      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/attendees`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.status).toBe('error');
    });

    it('should return matching attendees for an organizer search by name', async () => {
      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/attendees?q=Test`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.attendees).toBeInstanceOf(Array);

      const match = response.body.data.attendees.find(
        (attendee) => attendee.attendeeName === 'Test Attendee'
      );
      expect(match).toBeDefined();
      expect(match.attendeeEmail).toBe('attendee@example.com');
      expect(match.confirmationCode).toBeDefined();
      expect(match.ticketCode).toBeDefined();
      expect(match.qr.token).toBeDefined();
      expect(response.body.data.pagination).toBeDefined();
    });

    it('should return 200 for an active assigned staff member', async () => {
      const response = await request(app)
        .get(`/api/v1/checkins/${eventId}/attendees`)
        .set('Authorization', `Bearer ${staffToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.attendees).toBeInstanceOf(Array);
    });

    it('should allow staff to manually check in an attendee via the opaque qr token', async () => {
      const manualTicketCode = await prisma.ticketCode.create({
        data: {
          eventId,
          code: `TICKET-${randomBytes(4).toString('hex').toUpperCase()}`,
          attendeeEmail: 'manual@example.com',
          attendeeName: 'Manual Attendee',
        },
      });

      const manualReg = await prisma.registration.create({
        data: {
          eventId,
          ticketCodeId: manualTicketCode.id,
          attendeeEmail: 'manual@example.com',
          attendeeName: 'Manual Attendee',
          source: 'IMPORT',
          status: 'CONFIRMED',
          confirmationCode: `CONF-${randomBytes(4).toString('hex').toUpperCase()}`,
        },
      });

      const lookup = await request(app)
        .get(`/api/v1/checkins/${eventId}/attendees?q=Manual`)
        .set('Authorization', `Bearer ${staffToken}`);

      expect(lookup.status).toBe(200);
      const found = lookup.body.data.attendees.find((attendee) => attendee.id === manualReg.id);
      expect(found).toBeDefined();

      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/scan`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ token: found.qr.token });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.result).toBe('VALID');
      expect(response.body.data.attendeeName).toBe('Manual Attendee');
    });
  });

  describe('POST /api/v1/checkins/:eventId/checkins/:checkInId/undo', () => {
    it('should return 403 for staff who is neither the owner nor the scanning staff', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/checkins/${checkinId}/undo`)
        .set('Authorization', `Bearer ${staffToken}`);

      expect(response.status).toBe(403);
    });

    it('should return 200 and undo the checkin', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/checkins/${checkinId}/undo`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
    });

    it('should return 404 for already undone checkin', async () => {
      const response = await request(app)
        .post(`/api/v1/checkins/${eventId}/checkins/${checkinId}/undo`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(response.status).toBe(404);
    });
  });
});
