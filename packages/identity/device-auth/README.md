---
description: "Enroll devices and authenticate browser sessions with durable recovery credentials."
kind: "package-reference"
---
# @deepseek-ai/dsh-device-auth

English | [中文](README.zh.md)

## Summary

Enroll devices and authenticate browser sessions with durable recovery credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Service Definition for device enrollment, permanent recovery tokens, and one active browser session per device. A canonical branded principal id derives from issuer and subject; email is display and allowlist evidence, never identity input. Only enrollment and rotation return a permanent token. Enrollment also returns a browser session; rotation removes any active session and returns no replacement session, so the new token must be exchanged through login. Login accepts but never reflects that token and returns only a directly addressable `{ deviceId, id, secret }` browser session. Each authentication call explicitly selects `{ renew: true | false }`, so HTTP activity may roll the idle deadline while upgrade admission and expiry checks cannot. Lists, errors, diagnostics, and invalidation events contain no secret material.

<a id="model-experience"></a>
## Model Experience

### Device authentication

#### What the model sees

Nothing. `ctx.deviceAuth` registers no tools, injects no prompts, and appends no session events; callers use authentication results only in the host request path.

#### Token effect

Zero. No text from this package enters a model request.

#### KV Cache effect

Independent. Device authentication never changes a model request prefix and cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- This package defines host authentication only. HTTP routing, cookies, enrollment identity verification, and multi-user authorization belong to consumers.

No runtime invariant companion is published because the abstract device-auth service owns no persisted device state.

<a id="dev-note"></a>
### Dev Note

None.
