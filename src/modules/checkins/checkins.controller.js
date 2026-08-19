import * as checkinService from "./checkins.service.js";
import { success } from "../../utils/response.js";

export async function scanQr(req, res, next) {
  try {
    const result = await checkinService.scanQr(req.params.eventId, req.body, req.user.sub);
    return success(res, result, result.message);
  } catch (err) {
    next(err);
  }
}

export async function getCheckins(req, res, next) {
  try {
    const result = await checkinService.getCheckins(req.params.eventId, req.user.sub);
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function undoCheckin(req, res, next) {
  try {
    const result = await checkinService.undoCheckin(req.params.eventId, req.params.checkInId, req.user.sub);
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getCheckinStatistics(req, res, next) {
  try {
    const result = await checkinService.getCheckinStatistics(
      req.user.sub,
      req.user.role,
      { eventId: req.query.eventId }
    );

    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function listEventAttendees(req, res, next) {
  try {
    const result = await checkinService.listEventAttendees(
      req.params.eventId,
      req.user.sub,
      req.user.role,
      req.query
    );

    return success(res, result);
  } catch (err) {
    next(err);
  }
}
