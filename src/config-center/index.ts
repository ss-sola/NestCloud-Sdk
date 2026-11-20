import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { getOptions } from './options';
import { ProjectException } from '@/exception/global.exception';
import { enableConfigCenter } from './enable-config-center.decorator';
import { SYNC_CONFIG_INTERVAL } from '@/client/registry-client.constants';
import { ControlPlaneRequestUtil } from '@/client/control-plane-request.util';
import { isSameService } from '@/util/common.util';
import { ConfigKeys } from '@/config/keys';
import { DEFAULT_REMOTE_TIMEOUT } from '@/constants/http.constants';
import { ConfigSnapshotUtil } from './config-snapshot.util';

const logger = new Logger('ConfigCenter');

type ConfigCenterState = {
  serviceName: string;
  syncTime?: string;
  mainConfig: Record<string, any>;
  devConfig: Record<string, any>;
};

const configCenter: ConfigCenterState = {
  serviceName: '',
  syncTime: undefined,
  mainConfig: {},
  devConfig: {},
};

let refreshTimer: NodeJS.Timeout | undefined;

type RemoteConfigPayload = {
  configs?: Array<Record<string, any>>;
  mergedConfig?: Record<string, any>;
};

type ConfigClass<T> = new () => T;
type ConfigValueType = 'string' | 'number' | 'boolean' | 'json';

export async function initConfigCenter() {
  clearInterval(refreshTimer);
  configCenter.syncTime = undefined;
  configCenter.devConfig = {};
  configCenter.mainConfig = {};

  const options = getOptions();
  loadConfig();
  configCenter.serviceName = getConfig<string>(ConfigKeys.ServiceName, '', false);

  const serviceName = configCenter.serviceName;
  const enabled = enableConfigCenter(options.AppModule);
  if (enabled && shouldSkipInitialRemoteSync()) {
    logger.warn('Config center initial sync skipped because target points to current service');
  } else if (enabled) {
    try {
      await syncRemoteConfig(serviceName);
    } catch (error) {
      logger.error(
        `Config center initial sync failed, continue with local config: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  // 未获得有效远端快照时，本地配置也必须通过同一份服务校验规则才能启动。
  if (!configCenter.syncTime && options.validateConfig) validateConfig(options.validateConfig);
  if (!enabled) return;

  let refreshing = false;
  refreshTimer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await syncRemoteConfig(serviceName);
    } catch (error) {
      logger.error(
        `Config center refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      refreshing = false;
    }
  }, SYNC_CONFIG_INTERVAL);
}

export function getConfig<T>(
  key: string,
  defaultValue?: T,
  required = true,
  valueType?: ConfigValueType,
): T {
  // 凭证及其请求目标取自部署配置，避免远程配置将凭证发送到其他地址。
  const deploymentOnly =
    key === ConfigKeys.ControlPlaneToken ||
    (key === ConfigKeys.RegistryUrl && Boolean(getDeploymentValue(ConfigKeys.ControlPlaneToken)));
  const configuredValue = getValueByPath(configCenter.mainConfig, key);
  const value = deploymentOnly
    ? getDeploymentValue(key)
    : configuredValue === undefined
      ? process.env[key]
      : configuredValue;
  if (value === undefined && defaultValue === undefined && required) {
    throw new ProjectException(`Config key not found: ${key}`);
  }

  const resolvedValue = value ?? defaultValue;
  return convertConfigValue(
    key,
    resolvedValue,
    valueType ?? inferConfigValueType(defaultValue),
  ) as T;
}

function getDeploymentValue(key: string): unknown {
  return process.env[key] ?? getValueByPath(configCenter.devConfig, key);
}

export function validateConfig<T extends object>(
  configClass: ConfigClass<T>,
  candidate = configCenter.mainConfig,
) {
  const token = getConfig<string | undefined>(ConfigKeys.ControlPlaneToken, undefined, false);
  const snapshot: Record<string, any> = { ...candidate, [ConfigKeys.ControlPlaneToken]: token };
  if (token) {
    snapshot[ConfigKeys.RegistryUrl] = getConfig<string | undefined>(
      ConfigKeys.RegistryUrl,
      undefined,
      false,
    );
  }
  const instance = ConfigSnapshotUtil.validate(configClass, snapshot);
  configCenter.mainConfig = ConfigSnapshotUtil.merge(snapshot, instance);
  return instance;
}

/**
 * 加载本地配置文件到 devConfig，并初始化 mainConfig
 * @param filePaths 可选，配置文件路径数组。如果不传，则默认读取 src 同级的 .env 文件
 */
export function loadConfig(filePaths?: string[]) {
  if (!filePaths || filePaths.length === 0) {
    // 默认 src 同级下的 .env 文件
    const defaultEnv = path.resolve(process.cwd(), '.env');
    filePaths = [defaultEnv];
  }

  for (const filePath of filePaths) {
    const absPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(absPath)) {
      logger.warn(`Config file not found: ${absPath}`);
      continue;
    }

    let parsed: Record<string, any>;

    const raw = fs.readFileSync(absPath, 'utf-8');

    if (filePath.endsWith('.json')) {
      parsed = JSON.parse(raw);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      parsed = yaml.load(raw) as Record<string, any>;
    } else if (filePath.endsWith('.env')) {
      parsed = dotenv.parse(raw);
    } else {
      logger.warn(`Unsupported config file type: ${absPath}`);
      continue;
    }

    configCenter.devConfig = ConfigSnapshotUtil.merge(configCenter.devConfig, parsed);
  }

  configCenter.mainConfig = { ...configCenter.devConfig };
}

async function syncRemoteConfig(serviceName: string) {
  const configUrl = getConfig<string>(ConfigKeys.RegistryUrl);
  const names = getConfig<string>(ConfigKeys.ConfigNames, '', false)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(',');
  if (names.length === 0) {
    return;
  }
  const localOverrides = configCenter.devConfig;
  const token = getConfig<string | undefined>(ConfigKeys.ControlPlaneToken, undefined, false);
  const response = await axios.get(`${configUrl}/api/config-files/client/pull`, {
    timeout: DEFAULT_REMOTE_TIMEOUT,
    ...ControlPlaneRequestUtil.authOptions(token),
    params: {
      serviceName,
      names: names || undefined,
    },
  });

  const payload = unwrapResponsePayload<RemoteConfigPayload>(response.data);
  if (!ConfigSnapshotUtil.isObject(payload?.mergedConfig)) {
    throw new ProjectException('Config center response is missing a valid mergedConfig object');
  }
  if (localOverrides !== configCenter.devConfig) return;
  const remoteConfig = { ...payload.mergedConfig };
  delete remoteConfig[ConfigKeys.ControlPlaneToken];
  if (token) delete remoteConfig[ConfigKeys.RegistryUrl];
  const candidate = ConfigSnapshotUtil.merge(remoteConfig, localOverrides);
  const configClass = getOptions().validateConfig;
  if (configClass) {
    validateConfig(configClass, candidate);
  } else {
    configCenter.mainConfig = candidate;
  }
  configCenter.syncTime = new Date().toISOString();
}

function unwrapResponsePayload<T>(payload: any): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}

function inferConfigValueType(value: unknown): ConfigValueType | undefined {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return undefined;
}

function convertConfigValue(
  key: string,
  value: unknown,
  valueType: ConfigValueType | undefined,
): unknown {
  if (value === undefined || valueType === undefined) {
    return value;
  }

  if (valueType === 'number') {
    return convertNumberConfig(key, value);
  }
  if (valueType === 'boolean') {
    return ConfigSnapshotUtil.toBoolean(key, value);
  }
  if (valueType === 'json') {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  return convertStringConfig(key, value);
}

function convertNumberConfig(key: string, value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new ProjectException(`Config key type invalid: ${key} must be a number`);
}

function convertStringConfig(key: string, value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new ProjectException(`Config key type invalid: ${key} must be a string`);
}

function getValueByPath(obj: Record<string, any>, pathValue: string): unknown {
  return pathValue.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') {
      return undefined;
    }

    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function shouldSkipInitialRemoteSync(): boolean {
  const registryUrl = getConfig<string>(ConfigKeys.RegistryUrl, '', false);
  if (!registryUrl) {
    return false;
  }

  const port = getConfig<number>(ConfigKeys.Port, 0, false);
  const currentUrl = `http://127.0.0.1:${port}`;
  return isSameService(currentUrl, registryUrl);
}
