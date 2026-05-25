import type { NextFunction, Request, Response } from 'express';
import { createId } from './ids';

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const walletAddressPattern = /^0x[a-f0-9]{40}$/;

export interface RequestContext {
  requestId: string;
  sessionId: string | null;
  walletAddress: string | null;
}

export function requestContextMiddleware(request: Request, response: Response, next: NextFunction) {
  const requestId = createId('req');
  const sessionHeader = request.header('X-Session-Id');
  const walletHeader = request.header('X-Wallet-Address');
  const walletAddress =
    typeof walletHeader === 'string' && walletAddressPattern.test(walletHeader.trim().toLowerCase())
      ? walletHeader.trim().toLowerCase()
      : null;
  const sessionId = walletAddress ?? (typeof sessionHeader === 'string' && sessionIdPattern.test(sessionHeader) ? sessionHeader : null);

  response.setHeader('X-Request-Id', requestId);
  response.locals.requestContext = {
    requestId,
    sessionId,
    walletAddress
  } satisfies RequestContext;

  next();
}

export function getRequestContext(response: Response): RequestContext {
  const context = response.locals.requestContext as Partial<RequestContext> | undefined;

  return {
    requestId: typeof context?.requestId === 'string' ? context.requestId : '',
    sessionId: typeof context?.sessionId === 'string' ? context.sessionId : null,
    walletAddress: typeof context?.walletAddress === 'string' ? context.walletAddress : null
  };
}
