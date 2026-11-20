import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

class SessionConfig {
  @IsNotEmpty()
  @IsString()
  SessionSecret!: string;

  @IsNotEmpty()
  @IsString()
  SessionRedisUrl!: string;

  @IsOptional()
  @IsBoolean()
  SessionSecure?: boolean;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('refuses to start without a signing key', async () => {
  const { readSessionOptions } = await import('../../session/session.config');
  vi.stubEnv('SessionSecret', undefined);
  expect(() => readSessionOptions()).toThrow('SessionSecret');

  vi.stubEnv('SessionSecret', '   ');
  expect(() => readSessionOptions()).toThrow('SessionSecret');
});

it('selects the in-process store when only the signing key is supplied', async () => {
  const { readSessionOptions } = await import('../../session/session.config');
  vi.stubEnv('SessionSecret', 'fixture-signing-key');
  vi.stubEnv('SessionRedisUrl', undefined);
  expect(readSessionOptions()).toMatchObject({
    secret: 'fixture-signing-key',
    redisUrl: undefined,
  });
});

it('validates deployment credentials and passes them to the session factory', async () => {
  const { validateConfig } = await import('../../config-center');
  const { readSessionOptions } = await import('../../session/session.config');
  const redisUrl = 'redis://127.0.0.1:6379/2';
  vi.stubEnv('SessionSecret', 'fixture-signing-key');
  vi.stubEnv('SessionRedisUrl', redisUrl);
  vi.stubEnv('SessionSecure', 'false');

  const settings = validateConfig(SessionConfig);
  expect(settings.SessionSecure).toBeUndefined();
  expect(readSessionOptions()).toMatchObject({
    secret: settings.SessionSecret,
    redisUrl,
    secure: false,
  });
});
