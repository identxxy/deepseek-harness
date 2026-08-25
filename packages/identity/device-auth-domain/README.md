# @deepseek-ai/dsh-device-auth-domain

English | [中文](README.zh.md)

Durable `ctx.deviceAuth` provider over the `device_auth` storage domain. Permanent device credentials use a 32-byte secret, per-record salt, and scrypt; browser sessions use a separate 32-byte secret with SHA-256 and direct device-record lookup. A fresh login replaces the sole active session, while login never reflects the supplied permanent token. Token rotation durably replaces the permanent credential and removes the active session without creating another; the new token must pass through login before the device has an active session again. Rolling renewal extends the same session and secret. Teardown rejects new operations, drains admitted mutations, then closes the domain.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sessionIdleMs` | positive integer | 30 days | Browser-session idle lifetime |
| `sessionRenewBeforeMs` | positive integer below `sessionIdleMs` | 7 days | Remaining lifetime that triggers rolling renewal |
| `maxLabelBytes` | positive integer | 256 | Maximum UTF-8 device-label size |

Writes become authoritative only after storage durability. A failed write changes neither the in-memory view nor session-invalidation events. One DSH home supports one live writer; cross-process administration is not supported.

## Model Experience

### Durable authentication state

#### What the model sees

Nothing. The `device_auth` provider registers no tools, injects no prompts, and appends no session events; durable authentication state remains host-only.

#### Token effect

Zero. No stored field or diagnostic enters a model request.

#### KV Cache effect

Independent. Domain authentication reads and writes never change a model request prefix and cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- The provider does not bind credentials to hardware and does not provide multi-user ACLs. A copied permanent token remains usable until rotation or revocation.
