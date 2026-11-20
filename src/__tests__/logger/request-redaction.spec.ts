import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from '../../exception/global.filter';

afterEach(() => {
  vi.restoreAllMocks();
});

it('redacts nested credentials when logging a failed request without changing the request', () => {
  const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const request = {
    originalUrl: '/login',
    method: 'POST',
    params: { apiKey: 'mock-key' },
    query: { token: 'mock-token' },
    body: { users: [{ name: 'reader', password: 'mock-password' }] },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as ArgumentsHost;

  new GlobalExceptionFilter().catch(new HttpException('Invalid login', 400), host);

  const [message] = log.mock.calls[0];
  const entry = JSON.parse(String(message).split('\n')[0]);
  expect(entry.params).toEqual({ apiKey: '[REDACTED]' });
  expect(entry.query).toEqual({ token: '[REDACTED]' });
  expect(entry.body.users).toEqual([{ name: 'reader', password: '[REDACTED]' }]);
  expect(request.body.users[0].password).toBe('mock-password');
});
