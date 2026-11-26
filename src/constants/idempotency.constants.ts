/** 键作为不透明的大小写敏感标识；排除控制字符及重复头拼接使用的逗号。 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 幂等事务等待其他事务释放唯一键或业务行锁的最长时间。 */
export const IDEMPOTENCY_LOCK_TIMEOUT_MS = 3000;

/** PostgreSQL 锁等待超时的 SQLSTATE。 */
export const POSTGRES_LOCK_NOT_AVAILABLE = '55P03';

/** MySQL 主键已被另一事务成功占用。 */
export const MYSQL_DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

/** MySQL/InnoDB 占键时可以使用原幂等键重试的错误码。 */
export const MYSQL_RETRYABLE_LOCK_ERRORS = new Set(['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK']);
