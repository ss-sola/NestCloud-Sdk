// client/registry-client.constants.ts
export const REGISTRY_CLIENT_OPTIONS = Symbol('REGISTRY_CLIENT_OPTIONS');

export const HEARTBEAT_INTERVAL = 30_000; // 默认心跳间隔 30 秒
export const REGISTRY_LEASE_TIMEOUT_MS = HEARTBEAT_INTERVAL * 6;
export const SYNC_INTERVAL = 15_000; // 默认同步间隔 15 秒

export const REGISTER_RETRY_INTERVAL = 3_000; // 注册失败后默认每 3 秒重试一次

export const SYNC_CONFIG_INTERVAL = 60_000; // 同步配置间隔，默认 60 秒
