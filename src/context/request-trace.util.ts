import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import type { IncomingHttpHeaders } from 'node:http';

const TRACER_NAME = '@nest-cloud/sdk';

/** 有导出器时使用应用注册的 tracer。未配置采集端时仍生成可写入日志的 W3C 链路。 */
export class RequestTraceUtil {
  private static readonly propagator = new W3CTraceContextPropagator();
  private static readonly fallback = new TracerProvider().getTracer(TRACER_NAME);

  static receive(headers: IncomingHttpHeaders, name: string, kind = SpanKind.SERVER): Span {
    const parent = this.propagator.extract(ROOT_CONTEXT, headers, defaultTextMapGetter);
    return this.start(name, kind, parent);
  }

  static start(name: string, kind: SpanKind, parent: Context): Span {
    const span = trace.getTracer(TRACER_NAME).startSpan(name, { kind }, parent);
    const identity = span.spanContext();
    if (isSpanContextValid(identity) && identity.spanId !== trace.getSpanContext(parent)?.spanId)
      return span;
    span.end();
    return this.fallback.startSpan(name, { kind }, parent);
  }

  static contextOf(span: Span): Context {
    return trace.setSpan(context.active(), span);
  }

  static headers(span: Span): Record<string, string> {
    const headers: Record<string, string> = {};
    this.propagator.inject(this.contextOf(span), headers, defaultTextMapSetter);
    return headers;
  }

  static end(span: Span, error?: unknown) {
    if (error !== undefined) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  }
}
