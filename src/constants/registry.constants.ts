/** 生产环境使用注册中心发现业务服务。 */
export const PRODUCTION_NODE_ENV = 'production';

/** 服务基础地址允许内网主机名和路径前缀；认证信息、查询与片段均不属于基础地址。 */
export const SERVICE_BASE_URL_OPTIONS = {
  protocols: ['http', 'https'],
  require_protocol: true,
  require_tld: false,
  disallow_auth: true,
  allow_query_components: false,
  allow_fragments: false,
};
