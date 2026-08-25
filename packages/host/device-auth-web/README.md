# @deepseek-ai/dsh-host-device-auth-web

English | [中文](README.zh.md)

Opt-in Profile Bundle and Consumer plugin that claims the WebServer ingress seat and protects every remote HTTP request and WebSocket upgrade with `ctx.deviceAuth`. Its [`cordis.patch.yml`](cordis.patch.yml) installs the durable provider and this Consumer as two runtime rows, both resolved through this bundle's package exports so a local checkout install needs no extra profile dependency. The provider composition uses a one-year rolling browser-session idle lifetime and a 30-day renewal window, while permanent device tokens have no TTL. It owns the remote routes `/auth/device/enroll`, `/auth/device/login`, and `/auth/device/logout`, plus the local-only `/auth/device/admin` route.

Install or remove the complete feature as one Web-profile bundle:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-host-device-auth-web
dsh plugin --profile web remove @deepseek-ai/dsh-host-device-auth-web
```

Configuration requires an exact HTTPS `publicOrigin`, exact HTTPS Cloudflare Access `accessIssuer`, `accessAudience`, exact `accessEmail`, nonnegative `accessClockToleranceSeconds`, and positive `maxFormBytes`. Values are deployment inputs and contain no credential secret. Invalid values fail during plugin construction.

The bundle omits deployment values. The user profile supplies them by replacing the `device-auth-web` row's complete config in its `cordis.patch.yml`:

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

Enrollment trusts only `Cf-Access-Jwt-Assertion`. Verification fetches the issuer JWKS, permits RS256, and checks issuer, audience, expiration, not-before time, nonempty subject, and exact email. Login accepts a permanent device token through a bounded URL-encoded form but never reflects it. Enrollment displays a newly issued permanent token once. Authentication uses the `__Host-dsh_device_session` Secure, HttpOnly, SameSite=Strict cookie; logout clears it.

The local-only `/auth/device/admin` page lists secret-free device projections and supports revocation and permanent-token rotation. Access requires both a loopback TCP peer and loopback Host. Administration POSTs additionally require an Origin matching the current HTTP loopback authority. Rotation removes the target's active session, displays the replacement token once, and does not change the administration browser's session; the target exchanges that token through login.

Local bypass requires both a loopback TCP peer and a loopback Host name. A public Host arriving from a loopback tunnel peer remains authenticated. Public unsafe methods and all public upgrades require the exact configured Origin. Login and enrollment form POSTs accept an exact same-origin Referer only when Origin is absent; their form pages send this Referer without disclosing it cross-origin. Unauthenticated top-level HTML navigation redirects to login; assets and APIs receive 401. Host or request-source violations receive 403. Login and enrollment pages are self-contained and responses carrying authentication state are not cached.

## Model Experience

### Device-authenticated Web ingress

#### What the model sees

Nothing. The plugin reads `ctx.deviceAuth` only for Host admission and registers no tools, prompt sections, or session events.

#### Token effect

Zero. Authentication values never enter a model request.

#### KV Cache effect

Independent. Web authentication does not change model request prefixes.

## Known Limitations and Deferred Work

- The bundle requires an existing Web composition that provides WebServer and storage-domain services.
- Permanent credentials are portable bearer material, not hardware attestation.
