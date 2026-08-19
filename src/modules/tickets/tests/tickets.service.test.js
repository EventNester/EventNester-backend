import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenError, NotFoundError } from "../../../utils/error.js";

vi.mock("../../../database/index.js", () => ({
  default: {
    event: {
      findUnique: vi.fn(),
    },
    eventStaffAssignment: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    qrToken: {
      findUnique: vi.fn(),
    },
    registration: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    ticketType: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn((fn) => fn(prisma)),
  },
}));

vi.mock("../../registrations/registration.service.js", () => ({
  getRegistrationById: vi.fn(),
  listRegistrationsByEvent: vi.fn(),
}));

vi.mock("../qr.service.js", () => ({
  qrService: { createQrImage: vi.fn(), recoverRawToken: vi.fn() },
}));

vi.mock("../ticket-pdf.service.js", () => ({
  generateTicketListPdf: vi.fn(),
}));

import prisma from "../../../database/index.js";
import {
  getRegistrationById,
  listRegistrationsByEvent,
} from "../../registrations/registration.service.js";
import { qrService } from "../qr.service.js";
import { generateTicketListPdf } from "../ticket-pdf.service.js";

describe("TicketType Service (unit)", () => {
  const mockUserId = "user_1";
  const mockEventId = "event_1";
  const mockTicketTypeId = "tt_1";

  const mockEvent = {
    id: mockEventId,
    ownerId: mockUserId,
    deletedAt: null,
  };

  const mockTicketType = {
    id: mockTicketTypeId,
    eventId: mockEventId,
    name: "VIP",
    description: "VIP access",
    price: 5000,
    capacity: 100,
    quantitySold: 0,
    active: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.event.findUnique.mockResolvedValue(mockEvent);
    prisma.eventStaffAssignment.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.qrToken.findUnique.mockResolvedValue(null);
    prisma.registration.findMany.mockResolvedValue([]);
    getRegistrationById.mockResolvedValue(null);
    listRegistrationsByEvent.mockResolvedValue({ registrations: [], pagination: {} });
    qrService.createQrImage.mockResolvedValue(Buffer.from("qr"));
    qrService.recoverRawToken.mockResolvedValue(null);
  });

  function loadModule() {
    return import("../tickets.service.js");
  }

  describe("createTicketType", () => {
    it("should create a ticket type with auto-incremented sortOrder", async () => {
      prisma.ticketType.aggregate.mockResolvedValue({ _max: { sortOrder: 2 } });
      prisma.ticketType.create.mockResolvedValue(mockTicketType);

      const { createTicketType } = await loadModule();
      const result = await createTicketType(mockEventId, mockUserId, "ORGANIZER", {
        name: "VIP",
        price: 5000,
      });

      expect(result).toEqual(mockTicketType);
      expect(prisma.ticketType.create).toHaveBeenCalledWith({
        data: {
          eventId: mockEventId,
          name: "VIP",
          price: 5000,
          sortOrder: 3,
        },
      });
    });

    it("should start sortOrder at 0 when no existing ticket types", async () => {
      prisma.ticketType.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      prisma.ticketType.create.mockResolvedValue(mockTicketType);

      const { createTicketType } = await loadModule();
      await createTicketType(mockEventId, mockUserId, "ORGANIZER", { name: "VIP", price: 5000 });

      expect(prisma.ticketType.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sortOrder: 0 }),
        })
      );
    });

    it("should retry on P2002 (unique constraint) up to 3 times", async () => {
      prisma.ticketType.aggregate.mockResolvedValue({ _max: { sortOrder: 0 } });
      prisma.$transaction
        .mockRejectedValueOnce({ code: "P2002" })
        .mockRejectedValueOnce({ code: "P2002" })
        .mockResolvedValueOnce(mockTicketType);

      const { createTicketType } = await loadModule();
      const result = await createTicketType(mockEventId, mockUserId, "ORGANIZER", { name: "VIP", price: 5000 });

      expect(result).toEqual(mockTicketType);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it("should throw on non-P2002 error without retry", async () => {
      prisma.ticketType.aggregate.mockResolvedValue({ _max: { sortOrder: 0 } });
      prisma.$transaction.mockRejectedValue(new Error("DB down"));

      const { createTicketType } = await loadModule();
      await expect(
        createTicketType(mockEventId, mockUserId, "ORGANIZER", { name: "VIP", price: 5000 })
      ).rejects.toThrow("DB down");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("should throw ForbiddenError if user is not the event owner", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });

      const { createTicketType } = await loadModule();
      await expect(
        createTicketType(mockEventId, mockUserId, "ORGANIZER", { name: "VIP", price: 5000 })
      ).rejects.toThrow(ForbiddenError);
    });

    it("should allow an ADMIN to manage ticket types for events they do not own", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });
      prisma.ticketType.aggregate.mockResolvedValue({ _max: { sortOrder: 0 } });
      prisma.ticketType.create.mockResolvedValue(mockTicketType);
      prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

      const { createTicketType } = await loadModule();
      const result = await createTicketType(mockEventId, "admin_1", "ADMIN", {
        name: "VIP",
        price: 5000,
      });

      expect(result).toEqual(mockTicketType);
    });

    it("should throw NotFoundError if event does not exist", async () => {
      prisma.event.findUnique.mockResolvedValue(null);

      const { createTicketType } = await loadModule();
      await expect(
        createTicketType(mockEventId, mockUserId, "ORGANIZER", { name: "VIP", price: 5000 })
      ).rejects.toThrow("Event not found");
    });
  });

  describe("getTicketTypes", () => {
    it("should return ticket types ordered by sortOrder", async () => {
      const types = [
        { ...mockTicketType, id: "tt_1", sortOrder: 0 },
        { ...mockTicketType, id: "tt_2", name: "General", sortOrder: 1 },
      ];
      prisma.ticketType.findMany.mockResolvedValue(types);

      const { getTicketTypes } = await loadModule();
      const result = await getTicketTypes(mockEventId, mockUserId);

      expect(result).toEqual(types);
      expect(prisma.ticketType.findMany).toHaveBeenCalledWith({
        where: { eventId: mockEventId },
        orderBy: { sortOrder: "asc" },
      });
    });

    it("should throw ForbiddenError if user is not the event owner", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });

      const { getTicketTypes } = await loadModule();
      await expect(getTicketTypes(mockEventId, mockUserId)).rejects.toThrow(ForbiddenError);
    });
  });

  describe("updateTicketType", () => {
    it("should update and return the ticket type", async () => {
      prisma.ticketType.findFirst.mockResolvedValue(mockTicketType);
      const updated = { ...mockTicketType, name: "VVIP" };
      prisma.ticketType.update.mockResolvedValue(updated);

      const { updateTicketType } = await loadModule();
      const result = await updateTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER", {
        name: "VVIP",
      });

      expect(result).toEqual(updated);
      expect(prisma.ticketType.update).toHaveBeenCalledWith({
        where: { id: mockTicketTypeId },
        data: { name: "VVIP" },
      });
    });

    it("should throw NotFoundError if ticket type does not exist", async () => {
      prisma.ticketType.findFirst.mockResolvedValue(null);

      const { updateTicketType } = await loadModule();
      await expect(
        updateTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER", { name: "VVIP" })
      ).rejects.toThrow("Resource not found");
    });

    it("should throw ForbiddenError if user is not the event owner", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });

      const { updateTicketType } = await loadModule();
      await expect(
        updateTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER", { name: "VVIP" })
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("deleteTicketType", () => {
    it("should delete a ticket type", async () => {
      prisma.ticketType.findFirst.mockResolvedValue(mockTicketType);
      prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

      const { deleteTicketType } = await loadModule();
      const result = await deleteTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER");

      expect(result).toBe(true);
      expect(prisma.ticketType.delete).toHaveBeenCalledWith({
        where: { id: mockTicketTypeId },
      });
    });

    it("should throw NotFoundError if ticket type does not exist", async () => {
      prisma.ticketType.findFirst.mockResolvedValue(null);

      const { deleteTicketType } = await loadModule();
      await expect(
        deleteTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER")
      ).rejects.toThrow("Resource not found");
    });

    it("should throw ConflictError if ticket type has registrations", async () => {
      prisma.ticketType.findFirst.mockResolvedValue(mockTicketType);
      prisma.ticketType.delete.mockRejectedValue({ code: "P2003" });

      const { deleteTicketType } = await loadModule();
      await expect(
        deleteTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER")
      ).rejects.toThrow("Cannot delete ticket type with existing registrations");
    });

    it("should throw ForbiddenError if user is not the event owner", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });

      const { deleteTicketType } = await loadModule();
      await expect(
        deleteTicketType(mockEventId, mockTicketTypeId, mockUserId, "ORGANIZER")
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("getTicketDetails", () => {
    const registration = {
      id: "reg_1",
      eventId: mockEventId,
      attendeeEmail: "ada@example.com",
      attendeeName: "Ada Lovelace",
      ticketCode: { code: "TC-1" },
    };

    const qrRecord = {
      id: "qr_1",
      registrationId: "reg_1",
      tokenCipher: "cipher",
      revokedAt: null,
    };

    it("returns the ticket with the scan token and QR image for the event owner", async () => {
      getRegistrationById.mockResolvedValue(registration);
      prisma.qrToken.findUnique.mockResolvedValue(qrRecord);
      qrService.recoverRawToken.mockResolvedValue("raw-token");
      qrService.createQrImage.mockResolvedValue(Buffer.from("qr-bytes"));

      const { getTicketDetails } = await loadModule();
      const result = await getTicketDetails("reg_1", mockUserId, "ORGANIZER");

      expect(result).toEqual({
        ...registration,
        qr: { token: "raw-token", image: "data:image/png;base64,cXItYnl0ZXM=" },
        qrDataUrl: "data:image/png;base64,cXItYnl0ZXM=",
      });
      expect(getRegistrationById).toHaveBeenCalledWith("reg_1");
      expect(prisma.qrToken.findUnique).toHaveBeenCalledWith({
        where: { registrationId: "reg_1" },
      });
      expect(qrService.recoverRawToken).toHaveBeenCalledWith(qrRecord, expect.any(Object));
      expect(qrService.createQrImage).toHaveBeenCalledWith("raw-token");
    });

    it("returns null qr values when the registration has no QR token", async () => {
      getRegistrationById.mockResolvedValue(registration);
      prisma.qrToken.findUnique.mockResolvedValue(null);

      const { getTicketDetails } = await loadModule();
      const result = await getTicketDetails("reg_1", mockUserId, "ORGANIZER");

      expect(result.qr).toEqual({ token: null, image: null });
      expect(result.qrDataUrl).toBeNull();
      expect(qrService.createQrImage).not.toHaveBeenCalled();
    });

    it("allows the attendee by matching their email and returns the token", async () => {
      prisma.event.findUnique.mockResolvedValue({ ownerId: "other_user" });
      prisma.user.findUnique.mockResolvedValue({ id: "attendee", email: "ada@example.com" });
      getRegistrationById.mockResolvedValue(registration);
      prisma.qrToken.findUnique.mockResolvedValue(qrRecord);
      qrService.recoverRawToken.mockResolvedValue("attendee-token");

      const { getTicketDetails } = await loadModule();
      const result = await getTicketDetails("reg_1", "attendee", "ATTENDEE");

      expect(result.id).toBe("reg_1");
      expect(result.qr.token).toBe("attendee-token");
    });

    it("allows an ADMIN to view details and the token for events they do not own", async () => {
      prisma.event.findUnique.mockResolvedValue({ ownerId: "other_user" });
      getRegistrationById.mockResolvedValue(registration);
      prisma.qrToken.findUnique.mockResolvedValue(qrRecord);
      qrService.recoverRawToken.mockResolvedValue("admin-token");

      const { getTicketDetails } = await loadModule();
      const result = await getTicketDetails("reg_1", "admin_1", "ADMIN");

      expect(result.qr.token).toBe("admin-token");
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.eventStaffAssignment.findUnique).not.toHaveBeenCalled();
    });

    it("allows assigned staff to view details but never the raw token", async () => {
      prisma.event.findUnique.mockResolvedValue({ ownerId: "other_user" });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue({ eventId: mockEventId, userId: "staff", active: true });
      getRegistrationById.mockResolvedValue(registration);
      prisma.qrToken.findUnique.mockResolvedValue(qrRecord);

      const { getTicketDetails } = await loadModule();
      const result = await getTicketDetails("reg_1", "staff", "STAFF");

      expect(result.id).toBe("reg_1");
      expect(result.qr.token).toBeNull();
      expect(qrService.recoverRawToken).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.eventStaffAssignment.findUnique).toHaveBeenCalledWith({
        where: { eventId_userId: { eventId: mockEventId, userId: "staff" } },
        select: { active: true },
      });
    });

    it("denies deactivated staff", async () => {
      prisma.event.findUnique.mockResolvedValue({ ownerId: "other_user" });
      prisma.eventStaffAssignment.findUnique.mockResolvedValue({ eventId: mockEventId, userId: "staff", active: false });
      prisma.user.findUnique.mockResolvedValue({ id: "staff", email: "someone@example.com" });
      getRegistrationById.mockResolvedValue(registration);

      const { getTicketDetails } = await loadModule();
      await expect(getTicketDetails("reg_1", "staff", "STAFF")).rejects.toThrow(ForbiddenError);
    });

    it("throws ForbiddenError for a stranger with no matching user", async () => {
      prisma.event.findUnique.mockResolvedValue({ ownerId: "other_user" });
      getRegistrationById.mockResolvedValue(registration);

      const { getTicketDetails } = await loadModule();
      await expect(getTicketDetails("reg_1", "stranger", "ATTENDEE")).rejects.toThrow(ForbiddenError);
    });

    it("throws ForbiddenError when the user email does not match the attendee", async () => {
      prisma.event.findUnique.mockResolvedValue({ ownerId: "other_user" });
      prisma.user.findUnique.mockResolvedValue({ id: "other", email: "someone@example.com" });
      getRegistrationById.mockResolvedValue(registration);

      const { getTicketDetails } = await loadModule();
      await expect(getTicketDetails("reg_1", "other", "ATTENDEE")).rejects.toThrow(ForbiddenError);
    });

    it("propagates NotFoundError when the registration is missing", async () => {
      getRegistrationById.mockRejectedValue(new Error("Registration not found"));

      const { getTicketDetails } = await loadModule();
      await expect(getTicketDetails("reg_1", mockUserId, "ORGANIZER")).rejects.toThrow("Registration not found");
    });
  });

  describe("listEventTickets", () => {
    it("returns registrations from the registration service", async () => {
      listRegistrationsByEvent.mockResolvedValue({ registrations: [{ id: "r1" }], pagination: {} });

      const { listEventTickets } = await loadModule();
      const result = await listEventTickets(mockEventId, mockUserId, "ORGANIZER", { page: 2, limit: 10 });

      expect(result.registrations).toEqual([{ id: "r1" }]);
      expect(listRegistrationsByEvent).toHaveBeenCalledWith(mockEventId, 2, 10, {
        page: 2,
        limit: 10,
      });
    });

    it("passes empty filters when none are provided", async () => {
      const { listEventTickets } = await loadModule();
      await listEventTickets(mockEventId, mockUserId, "ORGANIZER");

      expect(listRegistrationsByEvent).toHaveBeenCalledWith(mockEventId, undefined, undefined, {});
    });

    it("throws ForbiddenError if user is not the event owner", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });

      const { listEventTickets } = await loadModule();
      await expect(listEventTickets(mockEventId, mockUserId, "ORGANIZER")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("exportEventTickets", () => {
    const registrations = [
      {
        attendeeName: 'Ada "Quoted"',
        attendeeEmail: "ada@example.com",
        ticketType: { name: "VIP" },
        status: "CONFIRMED",
        paymentStatus: "SUCCESS",
        ticketCode: { code: "TC-1" },
      },
      {
        attendeeName: "=SUM(A1)",
        attendeeEmail: "",
        ticketType: null,
        status: "",
        paymentStatus: "",
        ticketCode: null,
      },
    ];

    it("generates a CSV payload with escaped cells", async () => {
      prisma.registration.findMany.mockResolvedValue(registrations);

      const { exportEventTickets } = await loadModule();
      const result = await exportEventTickets(mockEventId, mockUserId, "ORGANIZER", "csv");

      expect(result.contentType).toBe("text/csv");
      expect(result.extension).toBe("csv");
      expect(result.data).toContain('"Name","Email","Ticket Type","Status","Payment","Ticket Code"');
      expect(result.data).toContain('"Ada ""Quoted"""');
      expect(result.data).toContain('"\'=SUM(A1)"');
      expect(prisma.registration.findMany).toHaveBeenCalledWith({
        where: { eventId: mockEventId },
        orderBy: { createdAt: "desc" },
        include: { ticketCode: true, ticketType: true },
      });
    });

    it("generates a PDF payload using generateTicketListPdf", async () => {
      prisma.registration.findMany.mockResolvedValue(registrations);
      prisma.event.findUnique.mockResolvedValue(mockEvent);
      generateTicketListPdf.mockResolvedValue(Buffer.from("pdf-bytes"));

      const { exportEventTickets } = await loadModule();
      const result = await exportEventTickets(mockEventId, mockUserId, "ORGANIZER", "pdf");

      expect(result.contentType).toBe("application/pdf");
      expect(result.extension).toBe("pdf");
      expect(result.data).toEqual(Buffer.from("pdf-bytes"));
      expect(generateTicketListPdf).toHaveBeenCalledWith(registrations, mockEvent);
    });

    it("throws BadRequestError for an unsupported format", async () => {
      const { exportEventTickets } = await loadModule();
      await expect(
        exportEventTickets(mockEventId, mockUserId, "ORGANIZER", "xml")
      ).rejects.toThrow("Unsupported export format");
    });

    it("throws ForbiddenError if user is not the event owner", async () => {
      prisma.event.findUnique.mockResolvedValue({ ...mockEvent, ownerId: "other_user" });

      const { exportEventTickets } = await loadModule();
      await expect(exportEventTickets(mockEventId, mockUserId, "ORGANIZER", "csv")).rejects.toThrow(
        ForbiddenError
      );
    });
  });

  describe("listMyTickets", () => {
    const baseRegistration = {
      id: "reg_1",
      eventId: "event_1",
      attendeeName: "Jane Doe",
      attendeeEmail: "jane@example.com",
      status: "CONFIRMED",
      paymentStatus: "SUCCESS",
      confirmationCode: "QP-123",
      ticketType: { id: "tt_1", name: "VIP", price: 5000 },
      ticketCode: { code: "TC-1" },
      event: {
        id: "event_1",
        title: "Tech Conference",
        slug: "tech-conf",
        venue: "Lagos",
        startTime: new Date(),
        endTime: new Date(),
        status: "PUBLISHED",
      },
      createdAt: new Date(),
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: mockUserId, email: "jane@example.com" });
      prisma.registration.count.mockResolvedValue(1);
    });

    it("returns the caller's tickets with derived check-in status and pagination", async () => {
      prisma.registration.findMany.mockResolvedValue([
        {
          ...baseRegistration,
          checkins: [{ id: "c1", result: "VALID", scannedAt: new Date() }],
        },
      ]);

      const { listMyTickets } = await loadModule();
      const result = await listMyTickets(mockUserId, 1, 10);

      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].ticketCode).toBe("TC-1");
      expect(result.tickets[0].checkedIn).toBe(true);
      expect(result.tickets[0].event.title).toBe("Tech Conference");
      expect(result.pagination).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });
    });

    it("marks a ticket as not checked in when no valid check-in exists", async () => {
      prisma.registration.findMany.mockResolvedValue([
        { ...baseRegistration, checkins: [{ id: "c1", result: "DUPLICATE", scannedAt: new Date() }] },
      ]);

      const { listMyTickets } = await loadModule();
      const result = await listMyTickets(mockUserId);

      expect(result.tickets[0].checkedIn).toBe(false);
    });

    it("recovers and returns the scan token so passes survive a device sync", async () => {
      const qrToken = { id: "qr_1", registrationId: "reg_1", tokenCipher: "cipher", revokedAt: null };
      prisma.registration.findMany.mockResolvedValue([
        { ...baseRegistration, checkins: [], qrToken },
      ]);
      qrService.recoverRawToken.mockResolvedValue("synced-token");

      const { listMyTickets } = await loadModule();
      const result = await listMyTickets(mockUserId);

      expect(result.tickets[0].qr.token).toBe("synced-token");
      expect(qrService.recoverRawToken).toHaveBeenCalledWith(qrToken, expect.objectContaining({ id: "event_1" }));
    });

    it("filters out soft-deleted and cancelled events", async () => {
      prisma.registration.findMany.mockResolvedValue([]);

      const { listMyTickets } = await loadModule();
      await listMyTickets(mockUserId);

      expect(prisma.registration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            attendeeEmail: { equals: "jane@example.com", mode: "insensitive" },
            event: expect.objectContaining({
              deletedAt: null,
              status: { not: "CANCELLED" },
            }),
          }),
        })
      );
    });

    it("returns an empty list when the user has no tickets", async () => {
      prisma.registration.findMany.mockResolvedValue([]);
      prisma.registration.count.mockResolvedValue(0);

      const { listMyTickets } = await loadModule();
      const result = await listMyTickets(mockUserId);

      expect(result.tickets).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it("throws NotFoundError when the user does not exist", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const { listMyTickets } = await loadModule();
      await expect(listMyTickets(mockUserId)).rejects.toThrow(NotFoundError);
    });
  });
});
