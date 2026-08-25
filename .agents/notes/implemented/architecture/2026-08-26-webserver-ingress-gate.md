# Agent Note: Single-owner Webserver Ingress Dispatch

Status: implemented

English | [中文](2026-08-26-webserver-ingress-gate.zh.md)

## Problem

An application-level access policy must run before every browser carrier reaches an HTTP exact route, prefix route, static fallback, automatic 404, matched upgrade route, or unmatched upgrade close. Registering checks in the current route owners duplicates policy, leaves newly added routes unprotected by default, and cannot cover the webserver's own 404 and unmatched-upgrade branches.

The webserver must provide this ordering without importing identity, authentication, cookie, origin, proxy, or harness concepts. Those decisions belong to a composing plugin, while the carrier owner remains responsible for routing and request-level error containment.

## Decision

`WebServer.registerIngressGate()` exposes one application-wide registration seat. Its owner implements both `handleHttp(req, res)` and `handleUpgrade(req, socket, head)`. Each method returns the closed `WebIngressDecision` union: `allow` continues to route lookup, while `handled` states that the owner has completed the response or socket and dispatch stops.

The ingress method runs before URL parsing and every matched or unmatched dispatch branch. A synchronous throw or rejected promise uses the existing HTTP or upgrade error containment, so policy failure cannot become an unhandled rejection or process exit.

The webserver tracks an upgrade socket before awaiting its ingress decision. Teardown therefore destroys and awaits a carrier whose policy is still pending, and dispatch stops if that pending decision later resolves after the socket was destroyed.

The seat rejects a duplicate registration during composition. Its disposer releases only the registration it created, and callers attach that disposer to the contributing Cordis effect. The webserver does not define policy ordering among multiple owners; a deployment that needs several checks composes them inside its sole ingress plugin.

## Alternatives considered

**Checks inside each route owner.** This keeps the webserver unchanged but makes complete coverage depend on every present and future route, cannot precede the built-in unmatched branches, and duplicates WebSocket handling.

**An ordered middleware chain.** Multiple independently ordered policy contributors create ambiguous short-circuit and response ownership semantics for a security-sensitive path. One owner gives the application one auditable decision point and can internally compose policies with domain-specific ordering.

**Authentication in the webserver package.** This would couple a harness-agnostic HTTP carrier to one deployment's identity and credential model. The webserver provides dispatch ordering and ownership only.

**A reverse proxy as the only enforcement point.** A proxy can remain part of deployment defense, but it does not protect direct non-loopback bindings or test the application's HTTP and WebSocket policy through the same runtime composition.

## Verification

Package tests and a real Loader composition cover execution before exact, prefix, fallback, 404, matched upgrade, and unmatched upgrade dispatch; synchronous and asynchronous `allow` and `handled` decisions; per-carrier failure containment; teardown while an asynchronous decision remains pending; duplicate registration; Cordis effect disposal; and stale-disposer isolation. Public types, JSDoc, and the bilingual package README define timing, return distinctions, ownership, failures, and the absence of built-in policy.

## Consequences

An ingress owner that returns `handled` without completing its carrier can leave a request or socket open; the return value deliberately transfers that lifecycle obligation to the owner. One registration seat also prevents independent plugins from layering checks without an explicit composing owner. Neither the type nor the webserver proves that an allowed request is authorized; security remains the responsibility of the registered policy plugin.
