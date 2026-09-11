# Agent Note: Demand-initialized syntax highlighter

Status: implemented

English | [中文](2026-09-11-demand-initialized-syntax-highlighter.zh.md)

## Problem

Shared UI primitives load during Web startup even when the user only browses Sessions or opens Kitty. A module-level timer that constructs the Shiki singleton therefore adds main-thread work without any code to highlight. Local CPU profiles identify singleton construction as a startup long task; they establish this machine's bottleneck, not a cross-device performance guarantee.

## Decision

`highlight.ts` constructs its document-local singleton synchronously on the first supported highlighting request. Importing the module schedules no singleton warm-up. Unknown or absent language hints remain plain without constructing it. The existing viewport activation of `CodeBlock` and `ReadBlock` delays supported requests until their content becomes visible, with the existing immediate fallback when `IntersectionObserver` is unavailable.

Construction retains representative tokenization of the three bundled grammars—TypeScript, shell and JSON—with `tokenizeTimeLimit: 0`. This prepares their scanner patterns outside the budget for scanning user content. The grammar modules remain bundled, the 23 extension grammars remain dynamically imported, and highlighting retains its synchronous output, token styles and streaming caches.

This decision owns initialization timing. The [Shiki selection](../process/2026-07-26-web-syntax-highlighting-shiki.md), [viewport activation](2026-08-31-viewport-activated-syntax-highlighting.md) and [read-card grammar loading](../feature/2026-07-30-web-read-card-frontend.md) decisions retain their independent dependency, rendering and lazy-import rationale.

## Alternatives considered

**Keep timer-based singleton prewarming at module load.** It can reduce latency for the first code block, but also constructs the highlighter on code-free and Kitty-only pages and competes with startup interaction work.

**Remove the bundled-grammar tokenization warm-up as well.** It would reduce initial construction work but move scanner-pattern compilation into the timeout applied to user content, weakening the existing protection against partial token streams under host contention. Demand initialization changes when that preparation runs, not its correctness role.

## Consequences

Code-free startup avoids singleton construction. The first activated supported block pays synchronous initialization and may introduce a long task; later blocks reuse the same instance. This does not reduce the initial bundle's grammar bytes or guarantee faster first-code rendering. No model-visible inputs, Session events or persisted data change.
