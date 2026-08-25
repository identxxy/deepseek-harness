# @deepseek-ai/dsh-host-device-auth-web

[English](README.md) | 中文

可选 Profile Bundle 与 Consumer 插件，占据 WebServer 入口席位，通过 `ctx.deviceAuth` 保护每个远程 HTTP 请求和 WebSocket upgrade。其 [`cordis.patch.yml`](cordis.patch.yml) 以两条 runtime row 安装 durable provider 与本 Consumer；两条 row 都通过本 bundle 的 package export 解析，因此从本地 checkout 安装时无需向 profile 增加其他 dependency。provider composition 使用一年滚动 browser-session idle lifetime 与 30 天 renewal window，永久 device token 则没有 TTL。它拥有远程路由 `/auth/device/enroll`、`/auth/device/login` 和 `/auth/device/logout`，以及仅限本机的 `/auth/device/admin` 路由。

以一个 Web profile bundle 安装或移除完整功能：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-host-device-auth-web
dsh plugin --profile web remove @deepseek-ai/dsh-host-device-auth-web
```

配置必须提供精确 HTTPS `publicOrigin`、精确 HTTPS Cloudflare Access `accessIssuer`、`accessAudience`、精确 `accessEmail`、非负 `accessClockToleranceSeconds` 和正数 `maxFormBytes`。这些值是部署输入，不含凭据 secret。无效配置在插件构造时失败。

bundle 不包含部署值。用户 profile 需要在自己的 `cordis.patch.yml` 中替换 `device-auth-web` row 的完整 config：

```yml
- id: device-auth-web
  config:
    publicOrigin: 'https://dsh.example.com'
    accessIssuer: 'https://example.cloudflareaccess.com'
    accessAudience: 'replace-with-access-application-aud'
    accessEmail: 'owner@example.com'
    accessClockToleranceSeconds: 5
    maxFormBytes: 8192
```

注册只信任 `Cf-Access-Jwt-Assertion`。验证会获取 issuer JWKS，只允许 RS256，并检查 issuer、audience、过期时间、not-before 时间、非空 subject 和精确 email。登录通过有界 URL 编码表单接收永久设备 token，但绝不回显。注册只显示一次新签发的永久 token。认证使用 Secure、HttpOnly、SameSite=Strict 的 `__Host-dsh_device_session` cookie；登出会清除它。

仅限本机的 `/auth/device/admin` 页面列出不含 secret 的设备信息，并支持撤销设备和轮换永久 token。访问同时要求 loopback TCP peer 与 loopback Host。管理 POST 还要求 Origin 与当前 HTTP loopback authority 精确匹配。轮换会移除目标的活跃 session，仅显示一次替代 token，且不改变管理浏览器的 session；目标随后通过登录交换该 token。

本地旁路要求 TCP peer 与 Host 名同时是 loopback。来自 loopback tunnel peer 的 public Host 仍需认证。远程不安全方法和所有远程 upgrade 都要求精确配置的 Origin。只有 Origin 缺失时，登录和注册表单 POST 才接受精确同源的 Referer；这些表单页面会发送该 Referer，但不会将其泄露到跨源请求。未认证顶层 HTML 导航重定向到登录；asset 与 API 得到 401。Host 或请求来源违规得到 403。登录和注册页完全自包含，携带认证状态的响应禁止缓存。

## 模型体验

### 设备认证 Web 入口

#### 模型看到的内容

无。插件只为 Host admission 读取 `ctx.deviceAuth`，不注册工具、prompt section 或 session event。

#### Token 影响

零。认证值不会进入模型请求。

#### KV Cache 影响

独立。Web 认证不会改变模型请求前缀。

## 已知限制与延期工作

- bundle 要求已有 Web composition 提供 WebServer 与 storage-domain service。
- 永久凭据是可复制 bearer material，不是硬件证明。
