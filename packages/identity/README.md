# identity/ — shared identity

English | [中文](README.zh.md)

Identity values shared across product domains. These values do not represent an authenticated account.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |
| [`device-auth/`](device-auth/README.md) | Long-lived device authentication Service Definition | `deviceAuth` |
| [`device-auth-domain/`](device-auth-domain/README.md) | Durable storage-domain provider | `deviceAuth` |
