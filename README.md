# NestCloud-Sdk

`@nest-cloud/sdk` 为 NestJS 服务提供配置热刷新、服务注册与发现、日志、会话和权限等公共能力。远程调用支持 W3C 链路传播和按操作重试。使用 PostgreSQL 或 MySQL InnoDB 的服务可在业务事务中记录幂等写入结果。 [链路传递与重试](./docs/http/链路传递与重试.md) · [写请求幂等](./docs/http/写请求幂等.md)

## 本地开发

使用 Node.js 24.16 或更高版本和项目声明的 pnpm 版本。在 SDK 根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
pnpm tsgo
```

构建产物和类型声明位于 `dist/`。本地开发时将 `NestCloud`、`NestCloud-Sdk` 和 `SolaCloud` 放在同一目录。消费者的依赖路径相对于其 `package.json` 计算，例如 NestCloud 根包的依赖写作 `"@nest-cloud/sdk": "file:../NestCloud-Sdk"`。先在 SDK 运行 `pnpm build`，再到消费方运行 `pnpm install`，将编译产物装入消费方的依赖树。修改 SDK 后也按此顺序更新。

MySQL 接入需要在业务服务中安装 `mysql2`，设置 `DbDriver=mysql` 并填写该实例的连接参数。启用写请求幂等前，在接收服务的业务库执行 NestCloud 仓库中对应数据库的建表脚本。 [数据库接入](./docs/database/初始化与约束.md) · [写请求幂等](./docs/http/写请求幂等.md)

## 接入

```ts
import { bootstrap } from '@nest-cloud/sdk';
import { AppModule } from './app.module';

void bootstrap({ AppModule });
```

部署时提供 `SessionSecret`。服务可从工作目录的 `.env`、配置中心或同名进程环境变量读取它。多个实例需要共享登录态时，同时提供 `SessionRedisUrl`。配置方式见[会话文档](./docs/session/能力总览.md)。

配置中心和注册中心按服务配置启用。详见[配置加载与合并](./docs/config-center/配置加载与合并.md)、[注册与发现流程](./docs/registry-client/注册与发现流程.md)和[公共能力导航](./docs/index.md)。
