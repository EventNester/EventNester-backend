import PDFDocument from 'pdfkit';
import { qrService } from './qr.service.js';
import prisma from '../../database/index.js';
import { NotFoundError, ForbiddenError } from '../../utils/error.js';
import { systemMessages } from '../../config/index.js';

const msg = systemMessages.ERROR;
const NAME_MAX_CHARS_PER_LINE = 40;

export async function generateTicketPdf(ticketId, userId) {
  const registration = await prisma.registration.findUnique({
    where: { id: ticketId },
    include: {
      event: true,
      ticketCode: true,
      ticketType: true,
      qrToken: true,
    },
  });

  if (!registration || registration.event?.deletedAt) {
    throw new NotFoundError(msg.TICKET.NOT_FOUND);
  }

  if (registration.event.ownerId !== userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user || user.email !== registration.attendeeEmail) {
      throw new ForbiddenError(msg.EVENT.UNAUTHORIZED);
    }
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 50, right: 50 },
    info: {
      Title: `Ticket - ${registration.event.title}`,
      Author: 'QPass',
    },
  });

  doc.fontSize(24).font('Helvetica-Bold').text('QPass', { align: 'center' });
  doc.moveDown(0.5);

  doc.fontSize(18).font('Helvetica-Bold').text(registration.event.title, { align: 'center' });
  doc.moveDown(0.5);

  const eventDate = new Date(registration.event.startTime).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const venue = registration.event.venue || 'No venue specified';
  doc.fontSize(11).font('Helvetica').text(`${eventDate} | ${venue}`, { align: 'center' });
  doc.moveDown(1.5);

  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(1);

  doc.fontSize(14).font('Helvetica-Bold').text('Attendee');
  doc.moveDown(0.5);

  const attendeeName = registration.attendeeName || '';
  const nameLines = wrapText(attendeeName, NAME_MAX_CHARS_PER_LINE);
  doc.fontSize(12).font('Helvetica');
  for (const line of nameLines) {
    doc.text(line);
  }

  doc.fontSize(11).font('Helvetica');
  doc.text(`Email: ${registration.attendeeEmail}`);
  if (registration.phone) {
    doc.text(`Phone: ${registration.phone}`);
  }
  doc.moveDown(1);

  doc.fontSize(14).font('Helvetica-Bold').text('Ticket Details');
  doc.moveDown(0.5);

  doc.fontSize(11).font('Helvetica');
  doc.text(`Ticket Type: ${registration.ticketType?.name || 'General'}`);
  doc.text(`Confirmation Code: ${registration.confirmationCode || 'N/A'}`);
  doc.text(`Status: ${registration.status}`);

  const startTime = new Date(registration.event.startTime).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
  });
  const endTime = new Date(registration.event.endTime).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
  });
  doc.text(`Time: ${startTime} - ${endTime}`);
  doc.moveDown(1.5);

  const qrRecord = registration.qrToken;
  if (qrRecord) {
    try {
      const rawToken = await qrService.recoverRawToken(qrRecord, registration.event);
      if (rawToken) {
        const qrBuffer = await qrService.createQrImage(rawToken, { width: 150 });
        const centerX = (doc.page.width - 150) / 2;
        doc.image(qrBuffer, centerX, doc.y, { width: 150, height: 150 });
        doc.moveDown(5);
      } else {
        doc.fontSize(10).font('Helvetica').text('QR code unavailable for this ticket', { align: 'center' });
        doc.moveDown(1);
      }
    } catch {
      doc.fontSize(10).font('Helvetica').text('QR code unavailable for this ticket', { align: 'center' });
      doc.moveDown(1);
    }
  } else {
    doc.fontSize(10).font('Helvetica').text('QR code unavailable for this ticket', { align: 'center' });
    doc.moveDown(1);
  }

  doc.moveDown(1);
  doc.fontSize(9).font('Helvetica-Oblique').text(
    'Present this ticket at the event entrance. A staff member will scan your QR code for entry.',
    { align: 'center' }
  );

  doc.end();
  return doc;
}

function wrapText(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }

  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine.length + 1 + word.length) <= maxChars) {
      currentLine += ` ${word}`;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Generates a PDF buffer for a single ticket.
 * @param {Object} registration - The registration record (includes event, ticketCode, ticketType)
 * @param {string} qrDataUrl - The base64 data URL of the QR code
 * @returns {Promise<Buffer>} The generated PDF as a buffer
 */
export async function generateIndividualTicketPdf(registration, qrDataUrl) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      doc.fontSize(24).font('Helvetica-Bold').text('QPass Ticket', { align: 'center' });
      doc.moveDown(2);

      const event = registration.event || {};
      doc.fontSize(18).text(event.title || 'Event Name', { underline: true });
      doc.fontSize(12).font('Helvetica').moveDown(0.5);
      if (event.venue) doc.text(`Venue: ${event.venue}`);
      if (event.startTime) doc.text(`Start Time: ${new Date(event.startTime).toLocaleString()}`);
      if (event.endTime) doc.text(`End Time: ${new Date(event.endTime).toLocaleString()}`);
      doc.moveDown(1.5);

      doc.fontSize(14).font('Helvetica-Bold').text('Attendee Information');
      doc.fontSize(12).font('Helvetica').moveDown(0.5);
      doc.text(`Name: ${registration.attendeeName}`);
      doc.text(`Email: ${registration.attendeeEmail}`);
      if (registration.ticketType) {
        doc.text(`Ticket Type: ${registration.ticketType.name}`);
      }
      doc.text(`Status: ${registration.status}`);
      doc.text(`Payment: ${registration.paymentStatus}`);
      doc.text(`Confirmation Code: ${registration.confirmationCode || 'N/A'}`);
      doc.moveDown(2);

      if (qrDataUrl) {
        const base64Data = qrDataUrl.replace(/^data:image\/\w+;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');

        doc.image(imgBuffer, {
          fit: [150, 150],
          align: 'center',
          valign: 'center'
        });
      }

      doc.moveDown(12);
      doc.fontSize(10).fillColor('gray').text(`Ticket Code: ${registration.ticketCode?.code || 'N/A'}`, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generates a PDF buffer containing a list of exported tickets.
 * @param {Array} registrations - The array of registration records
 * @param {Object} event - The event record
 * @returns {Promise<Buffer>} The generated PDF as a buffer
 */
export async function generateTicketListPdf(registrations, event) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const margin = 40;
      const usableWidth = 842 - margin * 2;
      const colWidths = [140, 200, 120, 90, 90, usableWidth - 140 - 200 - 120 - 90 - 90];
      const colX = [];
      let acc = margin;
      for (const w of colWidths) {
        colX.push(acc);
        acc += w;
      }

      doc.fontSize(20).font('Helvetica-Bold').text(`Ticket List: ${event.title}`, { align: 'center' });
      doc.fontSize(12).font('Helvetica').text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(2);

      const pageBottomLimit = 535;
      const headerLabels = ['Name', 'Email', 'Ticket Type', 'Status', 'Payment', 'Ticket Code'];

      function drawTableHeader(y) {
        doc.font('Helvetica-Bold').fontSize(10);
        for (let i = 0; i < headerLabels.length; i++) {
          doc.text(headerLabels[i], colX[i], y, { width: colWidths[i], lineBreak: false });
        }
        doc.moveTo(margin, y + 12).lineTo(842 - margin, y + 12).stroke();
        return y + 15;
      }

      let currentY = drawTableHeader(doc.y);

      doc.font('Helvetica').fontSize(9);
      for (const reg of registrations) {
        const cells = [
          reg.attendeeName || 'N/A',
          reg.attendeeEmail || 'N/A',
          reg.ticketType?.name || 'N/A',
          reg.status || 'N/A',
          reg.paymentStatus || 'N/A',
          reg.ticketCode?.code || 'N/A',
        ];

        let maxHeight = 0;
        for (let i = 0; i < cells.length; i++) {
          const h = doc.heightOfString(cells[i], { width: colWidths[i], lineBreak: true });
          if (h > maxHeight) maxHeight = h;
        }

        if (currentY + maxHeight + 5 > pageBottomLimit) {
          doc.addPage();
          currentY = drawTableHeader(margin);
        }

        for (let i = 0; i < cells.length; i++) {
          doc.text(cells[i], colX[i], currentY, { width: colWidths[i], lineBreak: true });
        }

        currentY += maxHeight + 5;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
