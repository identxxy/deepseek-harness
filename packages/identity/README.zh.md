# identity/ — 共享身份

[English](README.md) | 中文

跨产品领域共享的身份值。这些值不表示经过身份验证的账户。

| 包 | 职责 | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.zh.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |
| [`device-auth/`](device-auth/README.zh.md) | 长期设备认证 Service Definition | `deviceAuth` |
| [`device-auth-domain/`](device-auth-domain/README.zh.md) | 持久化 storage-domain provider | `deviceAuth` |
