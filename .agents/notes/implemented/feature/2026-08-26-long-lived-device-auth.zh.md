# Agent Note：长期设备认证

Status: implemented

[English](2026-08-26-long-lived-device-auth.md) | 中文

## 问题

Cloud access cookie 的有效期有限，而个人自托管 Harness 需要一种可恢复的设备凭据，并持续有效到所有者主动撤销或轮换。网络地址和 MAC 地址无法标识 Internet client，而且通常并不稳定。

## 决定

`ctx.deviceAuth` 将永久 device token 与日常 browser session 分离。注册接收已验证的 `{ issuer, subject, email }` principal。精确 issuer 与 subject string 的无歧义 JSON tuple 提供稳定 branded identity；URL 校验不归一化 issuer，subject whitespace 保留为身份数据，email 仅作为显示与 allowlist 证据。永久凭据采用带版本且可按 device 定址的格式、32-byte secret、逐记录 salt 与 scrypt 存储。它没有 TTL，仅通过轮换或撤销失效。

每台设备最多有一个活跃 browser session。其独立 32-byte secret 以 SHA-256 保存，逐请求认证无需运行 scrypt。session 携带 device id，因此认证只读取一条记录，不扫描 registry。登录替换活跃 session；登出、轮换和撤销移除它。轮换返回替代永久 token 但不创建 session，因此设备需要通过登录交换该 token。登录绝不回显永久 token 输入；只有注册与轮换签发 token。这些操作仅在持久化记录提交后发送 `device-auth/session-invalidated`。滚动续期延长同一 session 与 secret，不发送失效事件。

`device_auth` storage domain 为每台设备保存一条完整记录。durable read validation 在发布前检查 canonical principal id、编码后的 secret/hash/salt 精确长度、timestamp 与记录关系。storage-domain 串行化与 provider operation chain 防止并发登录或更新丢失。teardown 拒绝新操作、drain 已接纳 mutation chain，然后关闭 domain。持久化失败不会改变权威内存，也不会发送失效事件。原始凭据只出现在签发结果；view、event、error 与 diagnostic 均不包含 secret、salt 或 hash。认证 caller 显式选择该请求能否续期 idle deadline。

可选 `dsh-host-device-auth-web` package 同时是 Profile Bundle 与 Consumer，并在任何 exact、prefix、fallback、404、matched upgrade 或 unmatched upgrade 分派前占据 WebServer 入口席位。其 patch 以两条 runtime row 安装 durable provider 与 Consumer。两个 name 都通过已安装的 bundle package 解析；package-local Provider entry 重导出 domain provider，因此本地 `link:` 安装不依赖 pnpm 把传递 row package 提升到 profile 根。provider row 配置一年滚动 browser-session idle lifetime 与 30 天 renewal window；Consumer row 刻意省略部署值，由用户 profile 提供完整 config。本地旁路要求 TCP peer 与 Host 同时为 loopback；loopback tunnel 交付的 public Host 仍需认证。远程不安全方法和每个远程 upgrade 都要求精确配置的 Origin。只有 Origin 缺失时，登录和注册表单 POST 才接受精确同源的 Referer，从而兼容省略 Origin 的客户端，同时拒绝来源矛盾的请求。HTTP 活动可以续期 session，而 upgrade 准入和到期检查以不续期方式认证。session 失效会立即关闭匹配的 upgraded socket；较长到期间隔拆成有界 timer segment，且不会提前认证。

注册只信任 `Cf-Access-Jwt-Assertion`，通过 issuer JWKS 验证 RS256，并强制检查 issuer、audience、时间、subject 与精确 email claim。登录与注册使用有界 URL-encoded form，并拒绝重复字段。永久 token 只在注册后显示一次，登录绝不回显。带版本的 `__Host-dsh_device_session` cookie 使用 Secure、HttpOnly、SameSite=Strict 且 scope 为 `/`。选择可选 bundle 会安装该功能，但不会修改默认 profile 或上游 access policy；其余应用路径改用设备认证后，部署仍将注册路径保留在 identity provider 后方。

## Alternatives considered

Cloud access cookie 无法提供由所有者控制的无限有效期。MAC address 无法穿过 routed Internet，而且移动平台会随机化 MAC。逐个 browser request 运行 scrypt 会给 hot path 带来不必要的开销；独立且可撤销的 session 可以让永久 token 校验离开该路径。

## 影响

该凭据是可移动 bearer material，而非硬件证明。复制的 token 在撤销或轮换前仍可使用，并能替换该设备的 active browser session。一个 DSH home 只允许一个 live writer；跨进程管理与多用户 ACL 不在本设计内。部署在把上游 access protection 收窄到注册路径前，会通过已组装的 Consumer 验证 HTML、asset、API route 与 WebSocket upgrade。

## 验证

Package test 覆盖注册、JSON storage close/reopen、token 登录与轮换、撤销、单活跃 session 替换、并发登录、续期与过期边界、登出、配置拒绝、不含 secret 的 view 与 error、入口分类、cookie parsing、HTTP routing、同源 form fallback、矛盾 Origin 拒绝，以及本地 JWKS 支持的 assertion verification。Loader composition 覆盖插件发布与 disposal；真实 upgrade socket 与 fake-clock lifecycle case 覆盖 admission、invalidation、长 deadline、续期重排、partial-start rollback 与 pending-operation teardown。bundle contract test 解析发布 patch、固定其两条 row 与 provider default、验证必要 production dependency，并拒绝 bundle 中出现部署值。keyless assembled Web example 在 Chromium 中快照 login 与本地管理页面，并验证 public Host 未认证 HTML 与 API 的行为。
