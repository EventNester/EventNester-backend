import { Router } from "express";
import { 
  getTicketController,
  downloadTicketPdfController,
  listMyTicketsController
} from "./tickets.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { validateQuery } from "../../middlewares/validate.middleware.js";
import { myTicketsQuerySchema } from "./tickets.schema.js";

const router = Router({ mergeParams: true });

/**
 * @openapi
 * /api/v1/tickets/me:
 *   get:
 *     summary: List my tickets (ticket history)
 *     description: |
 *       Returns a paginated list of tickets belonging to the authenticated user,
 *       matched by their email. Includes event details, ticket type, ticket code,
 *       and whether the ticket has been checked in. Always scoped to the caller,
 *       so no role is required.
 *     tags: [Tickets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Paginated list of the caller's tickets
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
 *                         tickets:
 *                           type: array
 *                           items: { type: object }
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
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/me", requireAuth, validateQuery(myTicketsQuerySchema), listMyTicketsController);

/**
 * @openapi
 * /api/v1/tickets/{ticketId}:
 *   get:
 *     summary: Get ticket details
 *     description: |
 *       Retrieves details of a specific ticket (registration). For the event
 *       owner, an ADMIN, or the ticket holder (email match) the response
 *       includes `qr.token` — the raw opaque scan token — and a `qr.image` data
 *       URL encoding that same token, so gate-scannable PDFs can be rebuilt.
 *     tags: [Tickets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ticketId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ticket/Registration ID
 *     responses:
 *       200:
 *         description: Ticket details
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/TicketDetailResponse'
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — caller is not the ticket owner or event owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Ticket not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: "Validation error. Possible messages: Invalid ticket ID format"
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
router.get("/:ticketId", requireAuth, getTicketController);

/**
 * @openapi
 * /api/v1/tickets/{ticketId}/download:
 *   get:
 *     summary: Download ticket PDF
 *     description: Generates and downloads a PDF version of the ticket containing event details and QR code.
 *     tags: [Tickets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ticketId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ticket/Registration ID
 *     responses:
 *       200:
 *         description: PDF file buffer
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Unauthorized — missing or invalid Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden — caller is not the ticket owner or event owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Ticket not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: "Validation error. Possible messages: Invalid ticket ID format"
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
router.get("/:ticketId/download", requireAuth, downloadTicketPdfController);

export default router;
