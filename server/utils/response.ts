import type { Response } from 'express';

export function sendSuccess(response: Response, data: unknown) {
  return response.json({ success: true, data });
}

export function sendError(response: Response, code: string, message: string, details: unknown = {}) {
  return response.status(code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500).json({
    success: false,
    error: {
      code,
      message,
      details
    }
  });
}
