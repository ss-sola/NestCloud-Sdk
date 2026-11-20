import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsString, Min } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommonConfig } from '../../config/common.config';
import { SYNC_CONFIG_INTERVAL } from '../../client/registry-client.constants';
import { EnableConfigCenter } from '../../config-center/enable-config-center.decorator';
import { getConfig, initConfigCenter } from '../../config-center';
import { setOptions } from '../../config-center/options';

const mocks = vi.hoisted(() => ({ readEnv: vi.fn(), pull: vi.fn() }));
vi.mock('fs', () => ({ existsSync: () => true, readFileSync: mocks.readEnv }));
vi.mock('axios', () => ({ default: { get: mocks.pull } }));

@EnableConfigCenter()
class EnabledApp {}
class LocalApp {}

class UploadConfig extends CommonConfig {
  @IsBoolean()
  BullBoardEnabled!: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  UploadMaxSizeBytes = 5;

  @IsString()
  Channel = 'stable';
}

const local = [
  'ServiceName=upload',
  'Port=3300',
  'ConfigNames=upload.yaml',
  'RegistryUrl=http://localhost:3100',
].join('\n');

function response(mergedConfig: Record<string, unknown>) {
  return { data: { data: { mergedConfig } } };
}

describe('配置启动与热刷新', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    setOptions({ AppModule: EnabledApp, validateConfig: UploadConfig });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    ['false', false],
    ['true', true],
    ['0', false],
    ['1', true],
  ])('从本地 dotenv 配置读取布尔值 %s', async (raw, expected) => {
    setOptions({ AppModule: LocalApp, validateConfig: UploadConfig });
    mocks.readEnv.mockReturnValue(`${local}\nBullBoardEnabled=${raw}`);
    await initConfigCenter();
    expect(getConfig('BullBoardEnabled')).toBe(expected);
    expect(getConfig('Channel')).toBe('stable');
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it('本地布尔值不合法时阻止启动', async () => {
    setOptions({ AppModule: LocalApp, validateConfig: UploadConfig });
    mocks.readEnv.mockReturnValue(`${local}\nBullBoardEnabled=nope`);
    await expect(initConfigCenter()).rejects.toThrow('BullBoardEnabled');
  });

  it('校验整份远程快照，连续拒绝无效刷新并能在修正后恢复', async () => {
    mocks.readEnv.mockReturnValue(`${local}\nPort=3301`);
    mocks.pull
      .mockResolvedValueOnce(
        response({
          Port: 3302,
          BullBoardEnabled: 'false',
          UploadMaxSizeBytes: '12',
          Revision: 'a',
        }),
      )
      .mockResolvedValueOnce(
        response({ BullBoardEnabled: true, UploadMaxSizeBytes: -1, Revision: 'b' }),
      )
      .mockResolvedValueOnce(response({ BullBoardEnabled: 'off', Revision: 'c' }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce(response({ BullBoardEnabled: 1 }));

    await initConfigCenter();
    expect(getConfig('Port')).toBe(3301);
    expect(getConfig('BullBoardEnabled')).toBe(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      await vi.advanceTimersByTimeAsync(SYNC_CONFIG_INTERVAL);
      expect(getConfig('UploadMaxSizeBytes')).toBe(12);
      expect(getConfig('BullBoardEnabled')).toBe(false);
      expect(getConfig('Revision')).toBe('a');
    }
    await vi.advanceTimersByTimeAsync(SYNC_CONFIG_INTERVAL);
    expect(getConfig('BullBoardEnabled')).toBe(true);
    expect(getConfig('UploadMaxSizeBytes')).toBe(5);
    expect(getConfig('Channel')).toBe('stable');
    expect(getConfig('Revision', undefined, false)).toBeUndefined();
  });

  it('首次远程配置无效时使用已校验的本地配置', async () => {
    mocks.readEnv.mockReturnValue(`${local}\nBullBoardEnabled=0`);
    mocks.pull.mockResolvedValueOnce(response({ UploadMaxSizeBytes: -1 }));
    await initConfigCenter();
    expect(getConfig('UploadMaxSizeBytes')).toBe(5);
    expect(getConfig('BullBoardEnabled')).toBe(false);
  });

  it('上一轮尚未完成时不再发起下一次拉取', async () => {
    mocks.readEnv.mockReturnValue(local);
    let completeRefresh!: (value: ReturnType<typeof response>) => void;
    const delayed = new Promise<ReturnType<typeof response>>((resolve) => {
      completeRefresh = resolve;
    });
    mocks.pull
      .mockResolvedValueOnce(response({ BullBoardEnabled: false }))
      .mockReturnValueOnce(delayed);
    await initConfigCenter();
    await vi.advanceTimersByTimeAsync(SYNC_CONFIG_INTERVAL * 2);
    expect(mocks.pull).toHaveBeenCalledTimes(2);
    expect(getConfig('BullBoardEnabled')).toBe(false);
    completeRefresh(response({ BullBoardEnabled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getConfig('BullBoardEnabled')).toBe(true);
  });
});
