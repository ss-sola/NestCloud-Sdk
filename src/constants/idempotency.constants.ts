/** 键作为不透明的大小写敏感标识；排除控制字符及重复头拼接使用的逗号。 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** PostgreSQL 事务等待其他事务释放唯一键或业务行锁的最长时间。 */
export const IDEMPOTENCY_LOCK_TIMEOUT_MS = 3000;

/** PostgreSQL 锁等待超时的 SQLSTATE。 */
export const POSTGRES_LOCK_NOT_AVAILABLE = '55P03';
