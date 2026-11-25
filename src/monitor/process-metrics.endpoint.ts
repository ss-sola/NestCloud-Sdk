import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import { PROCESS_METRICS_PATH, ProcessMetricsAuth, ProcessMetricsSampler } from './process-metrics';

const CPU_SAMPLE_INTERVAL_MS = 2_000;
const DISK_SAMPLE_INTERVAL_MS = 10_000;

export class ProcessMetricsEndpoint {
  static install(app: NestExpressApplication, token: string): void {
    if (!token) return;
    const sampler = new ProcessMetricsSampler();
    const cpuTimer = setInterval(() => sampler.sampleCpu(), CPU_SAMPLE_INTERVAL_MS).unref();
    const diskTimer = setInterval(() => void sampler.sampleDisk(), DISK_SAMPLE_INTERVAL_MS).unref();
    void sampler.sampleDisk();
    const server: import('node:http').Server = app.getHttpServer();
    server.once('close', () => {
      clearInterval(cpuTimer);
      clearInterval(diskTimer);
    });

    const express: Express = app.getHttpAdapter().getInstance();
    express.get(PROCESS_METRICS_PATH, (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const signature = request.get('X-Service-Monitor-Signature') ?? '';
      if (!ProcessMetricsAuth.verify(token, request.get('Host') ?? '', signature)) {
        response.status(401).end();
        return;
      }
      response.json(sampler.snapshot());
    });
  }
}
