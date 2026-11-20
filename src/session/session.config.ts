import { getConfig } from '../config-center';
import { ConfigKeys } from '../config/keys';
import { ProjectException } from '../exception/global.exception';
import {
  SHARED_AUTH_SESSION_COOKIE_NAME,
  SHARED_AUTH_SESSION_KEY_PREFIX,
  SHARED_AUTH_SESSION_SAME_SITE,
  SHARED_AUTH_SESSION_SECURE,
  SHARED_AUTH_SESSION_TTL_MS,
} from '../system-auth/system-auth.constants';
import type { RedisSessionOptions } from './redis-session';

/** 在创建应用前读取会话配置，并检查部署提供的签名密钥。 */
export function readSessionOptions(): RedisSessionOptions {
  const secret = getConfig<string>(ConfigKeys.SessionSecret);
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new ProjectException('SessionSecret must be a non-empty string');
  }

  return {
    secret,
    redisUrl: getConfig<string | undefined>(ConfigKeys.SessionRedisUrl, undefined, false, 'string'),
    cookieName: getConfig<string>(ConfigKeys.SessionCookieName, SHARED_AUTH_SESSION_COOKIE_NAME),
    ttlMs: getConfig<number>(ConfigKeys.SessionTtlMs, SHARED_AUTH_SESSION_TTL_MS),
    keyPrefix: getConfig<string>(ConfigKeys.SessionKeyPrefix, SHARED_AUTH_SESSION_KEY_PREFIX),
    sameSite: getConfig<string>(ConfigKeys.SessionSameSite, SHARED_AUTH_SESSION_SAME_SITE),
    secure: getConfig<boolean>(ConfigKeys.SessionSecure, SHARED_AUTH_SESSION_SECURE),
  };
}
