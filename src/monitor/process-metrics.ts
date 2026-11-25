import { createHmac, timingSafeEqual } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

export const PROCESS_METRICS_PATH = '/_internal/process-metrics';
const SIGNATURE_WINDOW_MS = 30_000;

export interface ProcessMetricsSnapshot {
  collectedAt: string;
  /** 单个逻辑 CPU 满载为 100%，多线程进程可超过 100%。 */
  cpuPercent: number | null;
  cpuWindowMs: number | null;
  /** 服务运行环境报告的逻辑核心数和系统总内存，旧版快照可以缺省。 */
  cpuLogicalCoreCount?: number;
  systemTotalMemoryBytes?: number;
  systemUsedMemoryBytes?: number;
  diskTotalBytes?: number;
  diskUsedBytes?: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  uptimeSeconds: number;
}

export class ProcessMetricsAuth {
  static sign(token: string, authority: string, now = Date.now()): string {
    const signature = createHmac('sha256', token)
      .update(`GET\n${PROCESS_METRICS_PATH}\n${authority.toLowerCase()}\n${now}`)
      .digest('hex');
    return `${now}.${signature}`;
  }

  static verify(token: string, authority: string, header: string, now = Date.now()): boolean {
    if (!/^\d{13}\.[a-f0-9]{64}$/.test(header)) return false;
    const timestamp = Number(header.slice(0, 13));
    if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS) return false;
    return timingSafeEqual(
      Buffer.from(header),
      Buffer.from(this.sign(token, authority, timestamp)),
    );
  }
}

export class ProcessMetricsSampler {
  private readonly cpuLogicalCoreCount = cpus().length || undefined;
  private previousCpu = process.cpuUsage();
  private previousTime = performance.now();
  private cpuPercent: number | null = null;
  private cpuWindowMs: number | null = null;
  private disk?: { diskTotalBytes: number; diskUsedBytes: number };
  private samplingDisk = false;

  sampleCpu(): void {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const elapsed = now - this.previousTime;
    const used = cpu.user - this.previousCpu.user + cpu.system - this.previousCpu.system;
    this.previousTime = now;
    this.previousCpu = cpu;
    if (elapsed <= 0) return;
    this.cpuWindowMs = Math.round(elapsed);
    this.cpuPercent = Math.round((used / elapsed) * 10) / 100;
  }

  async sampleDisk(): Promise<void> {
    if (this.samplingDisk) return;
    this.samplingDisk = true;
    try {
      const { bsize, blocks, bfree } = await statfs(process.cwd(), { bigint: true });
      const diskTotalBytes = Number(bsize * blocks);
      const diskUsedBytes = Number(bsize * (blocks - bfree));
      this.disk =
        Number.isSafeInteger(diskTotalBytes) &&
        Number.isSafeInteger(diskUsedBytes) &&
        diskTotalBytes > 0 &&
        diskUsedBytes >= 0 &&
        diskUsedBytes <= diskTotalBytes
          ? { diskTotalBytes, diskUsedBytes }
          : undefined;
    } catch {
      this.disk = undefined;
    } finally {
      this.samplingDisk = false;
    }
  }

  snapshot(): ProcessMetricsSnapshot {
    const memory = process.memoryUsage();
    const systemTotalMemoryBytes = totalmem();
    return {
      collectedAt: new Date().toISOString(),
      cpuPercent: this.cpuPercent,
      cpuWindowMs: this.cpuWindowMs,
      cpuLogicalCoreCount: this.cpuLogicalCoreCount,
      systemTotalMemoryBytes,
      systemUsedMemoryBytes: Math.max(0, systemTotalMemoryBytes - freemem()),
      ...this.disk,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
