// client/registry-client.constants.ts
export const REGISTRY_CLIENT_OPTIONS = Symbol('REGISTRY_CLIENT_OPTIONS');

export const HEARTBEAT_INTERVAL = 30_000; // 默认心跳间隔 30 秒
export const REGISTRY_LEASE_TIMEOUT_MS = HEARTBEAT_INTERVAL * 6;
export const SYNC_INTERVAL = 15_000; // 默认同步间隔 15 秒
export const DISCOVERY_CACHE_MAX_AGE_INTERVALS = 4; // 快照最多使用四个同步周期
export const MAX_SYNC_INTERVAL = 2_147_483_647; // Node.js 定时器支持的最大毫秒数

export const REGISTER_RETRY_INTERVAL = 3_000; // 注册失败后默认每 3 秒重试一次
export const REGISTER_MAX_RETRIES = 5; // 注册失败后默认最多重试 5 次
export const MAX_REREGISTER_INTERVAL = 30_000; // 运行期重注册退避上限
export const REREGISTER_JITTER_RATIO = 0.2; // 在退避间隔内最多提前 20%，分散重试流量

export const SYNC_CONFIG_INTERVAL = 60_000; // 同步配置间隔，默认 60 秒
