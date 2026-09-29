import type { NextFunction, Request, Response } from "express";
import { logger } from "../util/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  logger.request("FADER", req.method, req.originalUrl);

  res.on("finish", () => {
    logger.response("FADER", req.method, req.originalUrl, res.statusCode, Date.now() - start);
  });

  next();
}
