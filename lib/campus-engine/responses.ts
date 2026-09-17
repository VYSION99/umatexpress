import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requestIdFromRequest, withRequestId } from "@/lib/observability";

export function ok<T extends Record<string, unknown>>(body: T, init?: ResponseInit, request?: Request) {
  const response = Response.json({ ok: true, ...body }, init);
  return request ? withRequestId(response, requestIdFromRequest(request)) : response;
}

export function fail(error: unknown, request?: Request) {
  const payload = campusErrorPayload(error);
  const response = Response.json(payload.body, { status: payload.status });
  return request ? withRequestId(response, requestIdFromRequest(request)) : response;
}
