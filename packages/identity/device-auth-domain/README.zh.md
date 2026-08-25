# @deepseek-ai/dsh-device-auth-domain

[English](README.md) | 中文

基于 `device_auth` storage domain 的持久化 `ctx.deviceAuth` provider。永久设备凭据使用 32-byte secret、逐记录 salt 和 scrypt；浏览器 session 使用独立 32-byte secret、SHA-256 与直接 device-record lookup。新登录会替换唯一活跃 session，而登录绝不回显传入的永久 token。Token 轮换会持久替换永久凭据并删除活跃 session，但不创建新 session；设备必须通过登录使用新 token，才会再次拥有活跃 session。rolling renewal 延长同一 session 与 secret。teardown 拒绝新操作、drain 已接纳 mutation，然后关闭 domain。

## 配置

| Key | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `sessionIdleMs` | 正整数 | 30 天 | 浏览器 session 空闲期限 |
| `sessionRenewBeforeMs` | 小于 `sessionIdleMs` 的正整数 | 7 天 | 触发滚动续期的剩余期限 |
| `maxLabelBytes` | 正整数 | 256 | UTF-8 设备标签最大字节数 |

storage 持久化完成后写入才成为权威状态。失败写入不会改变内存 view，也不会发送 session 失效事件。一个 DSH home 只支持一个 live writer；不支持跨进程管理。

## 模型体验

### 持久认证状态

#### 模型看到的内容

无。`device_auth` provider 不注册工具、不注入 prompt，也不追加 session event；持久认证状态仅供 host 使用。

#### Token 影响

为零。任何存储字段或 diagnostic 都不进入模型请求。

#### KV Cache 影响

相互独立。domain 认证读写不改变模型请求 prefix，不能使 provider cache reuse 失效。

## 已知限制与延后工作

- provider 不把凭据绑定至硬件，也不提供多用户 ACL。复制的永久 token 在轮换或撤销前仍可使用。
