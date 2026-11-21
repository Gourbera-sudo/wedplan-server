/** Operational error with an HTTP status the client should see. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function notFound(_req, res) {
  res.status(404).json({ error: "Not found." });
}

/** Central error handler — every failure response is `{ error: string }`. */
export function errorHandler(err, _req, res, _next) {
  const isOperational = err instanceof ApiError;
  const status = isOperational ? err.status : 500;
  // Unexpected errors are logged and masked; deliberate ApiErrors (including
  // 503 "not configured yet") show their message — it never contains secrets.
  if (!isOperational) console.error(err);
  res
    .status(status)
    .json({ error: isOperational ? err.message : "Internal server error." });
}
