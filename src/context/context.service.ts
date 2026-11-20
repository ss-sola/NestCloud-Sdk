import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'node:crypto';
import { context, SpanKind, type Span } from '@opentelemetry/api';
import { Request, Response } from 'express';
import { ContextExpectation } from '@/exception/global.exception';
import { AccountSessionRequest, CurrentAccountRecord } from '@/system-auth/system-auth.types';
import { RequestTraceUtil } from './request-trace.util';
import { IDEMPOTENCY_KEY_PATTERN } from '@/constants/idempotency.constants';

export const asyncLocalStorage = new AsyncLocalStorage<{
  req?: AccountSessionRequest;
  res?: Response;
  span: Span;
  operation?: { key: string; claimed: boolean };
}>();

export class ContextService {
  static setStore<T>({ req, res }: { req: Request; res: Response }, fn: () => T): T {
    const http = typeof res.once === 'function';
    const span = RequestTraceUtil.receive(
      req.headers ?? {},
      http ? `HTTP ${req.method}` : 'queue.consume',
      http ? SpanKind.SERVER : SpanKind.CONSUMER,
    );
    const run = () => asyncLocalStorage.run({ req, res, span }, fn);
    if (!http) return this.runUntilSettled(span, run);

    res.setHeader('x-trace-id', span.spanContext().traceId);
    const finish = () => {
      res.off('finish', finish);
      res.off('close', finish);
      if (req.route?.path) span.updateName(`${req.method} ${req.baseUrl ?? ''}${req.route.path}`);
      span.setAttribute('http.response.status_code', res.statusCode);
      RequestTraceUtil.end(
        span,
        res.statusCode >= 500 || !res.writableFinished ? res.statusCode : undefined,
      );
    };
    res.once('finish', finish);
    res.once('close', finish);
    return context.with(RequestTraceUtil.contextOf(span), run);
  }

  /** 定时任务或无入站请求的调用也为全部尝试保留同一个根链路。 */
  static withTrace<T>(fn: () => T): T {
    if (asyncLocalStorage.getStore()) return fn();
    const span = RequestTraceUtil.start('remote.call', SpanKind.INTERNAL, context.active());
    return this.runUntilSettled(span, () => asyncLocalStorage.run({ span }, fn));
  }

  private static runUntilSettled<T>(span: Span, fn: () => T): T {
    try {
      const result = context.with(RequestTraceUtil.contextOf(span), fn);
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (error) => {
            RequestTraceUtil.end(span, error);
            throw error;
          },
        ) as T;
      }
      span.end();
      return result;
    } catch (error) {
      RequestTraceUtil.end(span, error);
      throw error;
    }
  }

  static getTrace() {
    const identity = asyncLocalStorage.getStore()?.span.spanContext();
    return identity && { traceId: identity.traceId, spanId: identity.spanId };
  }

  static getTraceHeaders(): Record<string, string> {
    const span = asyncLocalStorage.getStore()?.span;
    return span ? RequestTraceUtil.headers(span) : {};
  }

  static createOutboundTrace(name = 'remote.attempt') {
    const parent = asyncLocalStorage.getStore()?.span;
    const span = RequestTraceUtil.start(
      name,
      SpanKind.CLIENT,
      parent ? RequestTraceUtil.contextOf(parent) : context.active(),
    );
    const { traceId, spanId } = span.spanContext();
    return {
      traceId,
      spanId,
      headers: RequestTraceUtil.headers(span),
      end: (error?: unknown) => RequestTraceUtil.end(span, error),
    };
  }

  /** 显式指定一次子调用的业务身份。多个并发步骤使用独立的作用域。 */
  static withOperationKey<T>(key: string, fn: () => T): T {
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw new ContextExpectation('操作键格式错误');
    return this.withTrace(() =>
      asyncLocalStorage.run(
        { ...asyncLocalStorage.getStore()!, operation: { key, claimed: false } },
        fn,
      ),
    );
  }

  static takeOperationKey(): string | undefined {
    const operation = asyncLocalStorage.getStore()?.operation;
    if (!operation) return undefined;
    if (operation.claimed) throw new ContextExpectation('一个操作键只可绑定一次出站调用');
    operation.claimed = true;
    return operation.key;
  }

  /** 只有上游显式声明了操作身份时才生成子步骤键。该头没有授权含义。 */
  static deriveOperationKey(step: string): string | undefined {
    const parent = this.getOptionalReq()?.headers['x-operation-id'];
    if (typeof parent !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(parent)) return undefined;
    return createHash('sha256')
      .update(JSON.stringify([parent, step]))
      .digest('hex');
  }

  static getOptionalReq(): AccountSessionRequest | undefined {
    return asyncLocalStorage.getStore()?.req;
  }

  static getReq(): AccountSessionRequest {
    const store = asyncLocalStorage.getStore();
    if (!store) throw new ContextExpectation();
    const req = store.req;
    if (!req) throw new ContextExpectation('请求上下文不存在');
    return req;
  }
  static getRes(): Response {
    const store = asyncLocalStorage.getStore();
    if (!store) throw new ContextExpectation();
    const res = store.res;
    if (!res) throw new ContextExpectation('请求上下文不存在');
    return res;
  }
  static getCurrentAccount() {
    return ContextService.getReq().session.account as CurrentAccountRecord;
  }
}
