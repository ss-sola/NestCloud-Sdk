import { describe, expect, it } from 'vitest';
import { cpus, totalmem } from 'node:os';
import { ProcessMetricsAuth, ProcessMetricsSampler } from '../../monitor/process-metrics';

describe('进程指标', () => {
  it('签名绑定请求地址、密钥和有效时间', () => {
    const now = 1_800_000_000_000;
    const host = '127.0.0.1:3200';
    const signature = ProcessMetricsAuth.sign('secret', host, now);
    expect(ProcessMetricsAuth.verify('secret', host, signature, now)).toBe(true);
    expect(ProcessMetricsAuth.verify('secret', '127.0.0.1:3500', signature, now)).toBe(false);
    expect(ProcessMetricsAuth.verify('other', host, signature, now)).toBe(false);
    expect(ProcessMetricsAuth.verify('secret', host, signature, now + 30_001)).toBe(false);
  });

  it('首份快照保留内存并区分 CPU 尚未采样', () => {
    const sampler = new ProcessMetricsSampler();
    expect(sampler.snapshot()).toMatchObject({
      cpuPercent: null,
      cpuWindowMs: null,
      cpuLogicalCoreCount: cpus().length || undefined,
      systemTotalMemoryBytes: totalmem(),
      systemUsedMemoryBytes: expect.any(Number),
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
    });
    sampler.sampleCpu();
    expect(sampler.snapshot().cpuPercent).toBeGreaterThanOrEqual(0);
  });

  it('采集工作目录文件系统的磁盘容量与已用空间', async () => {
    const sampler = new ProcessMetricsSampler();
    await sampler.sampleDisk();
    const { diskTotalBytes, diskUsedBytes } = sampler.snapshot();
    expect(diskTotalBytes).toBeGreaterThan(0);
    expect(diskUsedBytes).toBeGreaterThanOrEqual(0);
    expect(diskUsedBytes).toBeLessThanOrEqual(diskTotalBytes!);
  });
});
