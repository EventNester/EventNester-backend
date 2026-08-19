import { Router } from "express";
import * as checkinController from "./checkins.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireRole } from "../../middlewares/rbac.middleware.js";
import { validate, validateQuery, validateParams } from "../../middlewares/validate.middleware.js";
import {
  scanQrSchema,
  checkinStatsQuerySchema,
  scanEventIdParamsSchema,
  checkinListParamsSchema,
  attendeeLookupQuerySchema,
  undoCheckinParamsSchema,
} from "./checkins.schema.js";

const router = Router();

// Note on Routing Design:
// This router is mounted at /api/v1/checkins.
// Some endpoints below include an additional /checkins namespace segment
// (e.g., /:eventId/checkins/:checkInId/undo). This is intentional to prevent
// ambiguous route parameters and ensure the paths remain self-documenting.

/**
 * @openapi
 * /api/v1/checkins/stats:
 *   get:
 *     summary: Get check-in statistics
 *     description: |
 *       Returns aggregate check-in statistics. Without an `eventId` this is a
 *       system-wide summary (ADMIN only). With an `eventId` the caller must be
 *       the event owner, an ADMIN, or an active assigned staff member.
 *     tags: [Checkins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: eventId
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Optional event ID to scope statistics to
 *     responses:
 *       200:
 *         description: Check-in statistics
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         checkins:
 *                           type: object
 *                           properties:
 *                             total: { type: integer }
 *                             valid: { type: integer }
 *                             duplicate: { type: integer }
 *                         uniqueAttendeesCheckedIn: { type: integer }
 *                         eventsWithCheckins: { type: integer }
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — requires ADMIN (global) or event owner/staff (scoped)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: "Validation error. Possible messages: Invalid event ID format"
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/stats", requireAuth, validateQuery(checkinStatsQuerySchema), checkinController.getCheckinStatistics);

/**
 * @openapi
 * /api/v1/checkins/{eventId}/scan:
 *   post:
 *     summary: Scan a QR code to check in an attendee
 *     description: |
 *       Requires the caller to be the event owner or an active assigned staff member.
 *       Validates the QR token (not found → INVALID, expired → EXPIRED, registration not
 *       confirmed → INVALID, wrong event → WRONG_EVENT, revoked → REVOKED, already checked
 *       in → DUPLICATE), takes a Redis distributed lock to prevent duplicate in-flight
 *       scans, then creates a CheckIn row (enforced unique by eventId+registrationId).
 *       If the registration has a soft-deleted CheckIn row from an earlier undo, that
 *       row is restored and the result is VALID.
 *       Emits `checkin:update` on the dashboard room after every scan attempt.
 *     tags: [Checkins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ScanRequest'
 *     responses:
 *       200:
 *         description: Scan processed
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ScanResult'
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — requires STAFF or ORGANIZER role and event ownership/assignment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Scan already in progress (Redis lock held)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: "Validation error. Possible messages: token must not be empty"
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/:eventId/scan", requireAuth, requireRole("STAFF", "ORGANIZER"), validateParams(scanEventIdParamsSchema), validate(scanQrSchema), checkinController.scanQr);

/**
 * @openapi
 * /api/v1/checkins/{eventId}/checkins:
 *   get:
 *     summary: List all check-ins for an event
 *     tags: [Checkins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of check-ins
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { type: object }
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — requires STAFF or ORGANIZER role
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:eventId/checkins", requireAuth, requireRole("STAFF", "ORGANIZER"), validateParams(checkinListParamsSchema), checkinController.getCheckins);

/**
 * @openapi
 * /api/v1/checkins/{eventId}/attendees:
 *   get:
 *     summary: List attendees for manual gate check-in
 *     description: |
 *       Returns paginated event attendees with the details gate staff need to
 *       manually check someone in (name, email, phone, confirmation code,
 *       ticket code, status, payment status, checked-in flag) plus an opaque
 *       `qr.token` accepted by `POST /checkins/{eventId}/scan` for a manual
 *       check-in when the attendee's QR cannot be scanned.
 *
 *       Access mirrors the scan + dashboard rule: the event owner, an ADMIN,
 *       or an active assigned staff member. Unassigned users receive 403.
 *
 *       Search by name, email, phone, or confirmation code via the `q` query
 *       parameter (case-insensitive partial match).
 *     tags: [Checkins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Event ID
 *       - in: query
 *         name: q
 *         required: false
 *         schema: { type: string, maxLength: 255 }
 *         description: Search by attendee name, email, phone, or confirmation code
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *         description: Items per page
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, CONFIRMED, CANCELLED] }
 *         description: Filter by registration status
 *     responses:
 *       200:
 *         description: Paginated list of attendees
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         attendees:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id: { type: string, description: Registration ID }
 *                               attendeeName: { type: string }
 *                               attendeeEmail: { type: string }
 *                               phone: { type: string, nullable: true }
 *                               confirmationCode: { type: string, nullable: true }
 *                               ticketCode: { type: string, nullable: true }
 *                               status: { type: string }
 *                               paymentStatus: { type: string }
 *                               checkedIn: { type: boolean }
 *                               qr:
 *                                 type: object
 *                                 properties:
 *                                   token: { type: string, description: 'Opaque token accepted by POST /checkins/{eventId}/scan for manual check-in' }
 *                                   issued: { type: boolean }
 *                         pagination:
 *                           type: object
 *                           properties:
 *                             page: { type: integer }
 *                             limit: { type: integer }
 *                             total: { type: integer }
 *                             totalPages: { type: integer }
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — requires event ownership or an active staff assignment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Event not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: "Validation error. Possible messages: Invalid event ID format, Invalid query parameters"
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:eventId/attendees", requireAuth, requireRole("STAFF", "ORGANIZER", "ADMIN"), validateParams(checkinListParamsSchema), validateQuery(attendeeLookupQuerySchema), checkinController.listEventAttendees);

/**
 * @openapi
 * /api/v1/checkins/{eventId}/checkins/{checkInId}/undo:
 *   post:
 *     summary: Undo a check-in
 *     description: |
 *       Allowed for the event owner or the staff member who performed the check-in,
 *       within 24 hours of the scan. Soft-deletes the CheckIn row (sets deletedAt),
 *       reverts the registration status to CONFIRMED, re-enables the QR token, and
 *       writes an audit log entry with a before-snapshot.
 *     tags: [Checkins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: checkInId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Check-in undone
 *       400:
 *         description: Check-in is older than 24 hours
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — requires STAFF or ORGANIZER role and event ownership or scanning staff membership
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Check-in not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/:eventId/checkins/:checkInId/undo", requireAuth, requireRole("STAFF", "ORGANIZER"), validateParams(undoCheckinParamsSchema), checkinController.undoCheckin);

export default router;
