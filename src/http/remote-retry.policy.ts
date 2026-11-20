import axios from 'axios';
import {
  REMOTE_RETRY_BASE_DELAY_MS,
  REMOTE_RETRY_BUDGET_MS,
  REMOTE_RETRY_MAX_ATTEMPTS,
  TRANSIENT_HTTP_STATUSES,
  TRANSIENT_NETWORK_CODES,
} from '@/constants/remote-retry.constants';

/** 一次逻辑调用独占一个预算。仅校验通过的内部读操作或已保护的写操作启用。 */
export class RemoteRetryPolicy {
  private readonly deadline = performance.now() + REMOTE_RETRY_BUDGET_MS;

  constructor(private readonly enabled: boolean) {}

  /** 超过总预算后不再启动请求。Axios timeout 控制每次尝试，signal 控制整个请求的硬时限。 */
  requestLimits(timeout?: number) {
    if (!this.enabled) return { timeout };
    const remaining = this.remainingMs();
    if (!remaining) return undefined;
    return {
      timeout: Math.min(timeout ?? remaining, remaining),
      signal: AbortSignal.timeout(remaining),
      maxRedirects: 0,
    };
  }

  nextDelay(error: unknown, attempt: number): number | undefined {
    if (!this.enabled || attempt >= REMOTE_RETRY_MAX_ATTEMPTS || !axios.isAxiosError(error)) return;
    const status = error.response?.status;
    const retryAfter = RemoteRetryPolicy.retryAfterMs(error.response?.headers?.['retry-after']);
    if (status !== undefined) {
      if (!TRANSIENT_HTTP_STATUSES.has(status) && !(status === 429 && retryAfter !== undefined))
        return;
    } else if (!TRANSIENT_NETWORK_CODES.has(error.code ?? '')) {
      return;
    }
    const jitter = Math.floor(Math.random() * REMOTE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    const delay = Math.max(jitter, retryAfter ?? 0);
    return delay < this.remainingMs() ? delay : undefined;
  }

  private remainingMs(): number {
    return Math.max(0, Math.floor(this.deadline - performance.now()));
  }

  private static retryAfterMs(value: unknown): number | undefined {
    if (typeof value !== 'string') return;
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    // HTTP-date 包含英文日期或月份名称，防止 Date.parse 将非法数值解析为日期。
    if (!/[a-z]{3}/i.test(value)) return;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
  }
}
