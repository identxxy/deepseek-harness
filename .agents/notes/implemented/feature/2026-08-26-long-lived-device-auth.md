# Agent Note: Long-lived device authentication

Status: implemented

English | [中文](2026-08-26-long-lived-device-auth.zh.md)

## Problem

Cloud access cookies have a finite lifetime, while a personal self-hosted Harness needs a recoverable device credential that remains valid until the owner revokes or rotates it. Network addresses and MAC addresses cannot identify an Internet client and are routinely unstable.

## Decision

`ctx.deviceAuth` separates a permanent device token from an ordinary browser session. Enrollment accepts an already verified `{ issuer, subject, email }` principal. An unambiguous JSON tuple of the exact issuer and subject strings supplies the stable branded identity; URL validation does not normalize the issuer, subject whitespace remains identity data, and email remains display and allowlist evidence. The permanent credential has a versioned, device-addressable format, a 32-byte secret, a per-record salt, and scrypt storage. It has no TTL. Rotation or revocation is its only invalidation.

Each device has at most one active browser session. Its independent 32-byte secret is stored as SHA-256 so request-path authentication does not run scrypt. The session carries its device id, so authentication loads one record without scanning the registry. Login replaces the active session; logout, rotation, and revocation remove it. Rotation returns the replacement permanent token without creating a session, so the device exchanges that token through login. Login never reflects its permanent-token input; only enrollment and rotation issue one. These operations emit `device-auth/session-invalidated` only after the durable record commits. Rolling renewal extends the same session and secret without emitting invalidation.

The `device_auth` storage domain keeps one complete record per device. Durable read validation checks canonical principal ids, exact encoded secret/hash/salt lengths, timestamps, and record relationships before publication. Storage-domain serialization and the provider operation chain prevent concurrent login or update loss. Teardown rejects new operations, drains the admitted mutation chain, then closes the domain. A durability failure leaves authoritative memory unchanged and emits no invalidation event. Raw credentials occur only in issuance results; views, events, errors, and diagnostics omit secret, salt, and hash material. Authentication callers explicitly select whether the request may renew the idle deadline.

The opt-in `dsh-host-device-auth-web` package is both a Profile Bundle and the Consumer that claims the WebServer ingress seat before any exact, prefix, fallback, 404, matched upgrade, or unmatched upgrade dispatch. Its patch installs the durable provider and Consumer as two runtime rows. Both names resolve through the installed bundle package; the package-local Provider entry re-exports the domain provider so a local `link:` install does not depend on pnpm hoisting a transitive row package into the profile root. The provider row configures a one-year rolling browser-session idle lifetime and a 30-day renewal window; the Consumer row deliberately omits deployment values so the user profile supplies its complete config. Local bypass requires both a loopback TCP peer and loopback Host; a public Host delivered by a loopback tunnel remains authenticated. Public unsafe methods and every public upgrade require the exact configured Origin. Login and enrollment form POSTs accept an exact same-origin Referer only when Origin is absent, supporting clients that omit Origin without accepting a contradictory source. HTTP activity may renew a session, while upgrade admission and expiry checks authenticate without renewal. Session invalidation closes matching upgraded sockets immediately, and long expiry intervals are scheduled in bounded timer segments without authenticating early.

Enrollment trusts only `Cf-Access-Jwt-Assertion`, verifies RS256 through the issuer JWKS, and enforces issuer, audience, time, subject, and exact email claims. Login and enrollment use bounded URL-encoded forms with duplicate rejection. The permanent token is displayed once after enrollment and is never reflected by login. The versioned `__Host-dsh_device_session` cookie is Secure, HttpOnly, SameSite=Strict, and scoped to `/`. Selecting the optional bundle installs the feature without changing a default profile or mutating an upstream access policy; deployment keeps enrollment behind its identity provider after the remaining application paths move to device authentication.

## Alternatives considered

Cloud access cookies cannot supply an owner-controlled indefinite lifetime. MAC-address binding cannot cross the routed Internet and mobile platforms randomize MAC addresses. Running scrypt for every browser request would unnecessarily make the hot path expensive; a separate revocable session keeps permanent-token verification off that path.

## Consequences

The credential is portable bearer material, not hardware attestation. A copied token works until revoked or rotated and can replace the device's active browser session. One DSH home permits one live writer; cross-process administration and multi-user ACLs are outside this design. Deployment verifies the assembled Consumer over HTML, assets, API routes, and WebSocket upgrades before narrowing upstream access protection to enrollment.

## Verification

Package tests cover enrollment, JSON storage close/reopen, token login and rotation, revocation, one-active-session replacement, concurrent login, renewal and expiry boundaries, logout, config rejection, secret-free views and errors, ingress classification, cookie parsing, HTTP routing, same-origin form fallback, contradictory Origin rejection, and local JWKS-backed assertion verification. A Loader composition covers plugin publication and disposal; real upgrade sockets and fake-clock lifecycle cases cover admission, invalidation, long deadlines, renewal rescheduling, partial-start rollback, and pending-operation teardown. A bundle contract test parses the published patch, pins its two rows and provider defaults, verifies required production dependencies, and rejects deployment values in the bundle. A keyless assembled Web example snapshots the login and local administration pages and verifies unauthenticated public-Host HTML and API behavior in Chromium.
