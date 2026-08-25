# @deepseek-ai/dsh-device-auth

[English](README.md) | 中文

设备注册、永久恢复 token 与每台设备唯一活跃浏览器 session 的 Service Definition。canonical branded principal id 由 issuer 与 subject 派生；email 仅用于显示和 allowlist 证据，不参与身份计算。只有注册与轮换返回永久 token。注册同时返回 browser session；轮换会删除当前 session，不创建替代 session，因此必须通过登录使用新 token 换取 session。登录接收但绝不回显该 token，只返回可直接定址的 `{ deviceId, id, secret }` browser session。每次认证都显式选择 `{ renew: true | false }`，因此 HTTP 活动可滚动 idle deadline，而 upgrade 准入和到期检查不能续期；列表、错误、诊断与失效事件均不包含 secret。

## 模型体验

### 设备认证

#### 模型看到的内容

无。`ctx.deviceAuth` 不注册工具、不注入 prompt，也不追加 session event；caller 只在 host request path 使用认证结果。

#### Token 影响

为零。本包没有文本进入模型请求。

#### KV Cache 影响

相互独立。设备认证不改变模型请求 prefix，不能使 provider cache reuse 失效。

## 已知限制与延后工作

- 本包只定义 host 认证。HTTP routing、cookie、注册身份验证与多用户授权属于 consumer。
