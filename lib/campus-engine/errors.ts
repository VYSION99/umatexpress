export type CampusErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "CONFIG_REQUIRED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "NO_DRIVER_FOUND"
  | "PASSWORD_CHANGE_REQUIRED"
  | "PAYMENT_REQUIRED"
  | "ENGINE_ERROR";

export class CampusEngineError extends Error {
  code: CampusErrorCode;
  status: number;

  constructor(code: CampusErrorCode, message: string, status = 400) {
    super(message);
    this.name = "CampusEngineError";
    this.code = code;
    this.status = status;
  }
}

export function campusErrorPayload(error: unknown) {
  if (error instanceof CampusEngineError) {
    return { status: error.status, body: { ok: false, code: error.code, error: error.message } };
  }
  const message = error instanceof Error ? error.message : "CampusRide request failed.";
  return { status: 500, body: { ok: false, code: "ENGINE_ERROR", error: message } };
}
