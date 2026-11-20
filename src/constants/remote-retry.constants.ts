/** 显式允许重试的调用总共尝试三次；单次请求仍使用 @RemoteCall 的超时设置。 */
export const REMOTE_RETRY_MAX_ATTEMPTS = 3;
/** 从第一次请求开始，共享此预算（包括退避和等待响应）。 */
export const REMOTE_RETRY_BUDGET_MS = 20_000;
/** 首次退避的上限，后续采用带随机抖动的指数退避。 */
export const REMOTE_RETRY_BASE_DELAY_MS = 100;
/** 仅重试暂时性网关错误；普通 500 可能是确定性的业务错误。 */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** Axios/Node 明确报告的暂时性传输错误；调用取消与证书错误不重试。 */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);
