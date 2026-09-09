import type express from "express";

/**
 * Express 4 does not catch a rejected promise returned from a route handler —
 * an async handler that throws leaves the request hanging forever instead of
 * reaching an error middleware. Wrap every async handler with this so
 * rejections are forwarded to `next(err)` and handled centrally.
 */
export function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
