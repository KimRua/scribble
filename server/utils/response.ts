import type { Response } from 'express';
import { logError } from './logger';
import { getRequestContext } from './requestContext';

export function sendSuccess(response: Response, data: unknown) {
  return response.json({ success: true, data });
}

export function sendError(response: Response, code: string, message: string, details: unknown = {}) {
  const statusCode = code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500;
  const { requestId, sessionId } = getRequestContext(response);
  logError('api_error_response', {
    requestId,
    ...(sessionId ? { sessionId } : {}),
    path: response.req.path,
    method: response.req.method,
    statusCode,
    code,
    message
  });

  return response.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details
    }
  });
}
