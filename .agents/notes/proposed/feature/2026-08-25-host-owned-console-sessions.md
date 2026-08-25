# Agent Note: Host-owned Console sessions

Status: proposed

English | [中文](2026-08-25-host-owned-console-sessions.zh.md)

## Problem

The persistent Terminal capability is owned by one exact live Agent and adapts a PTY into line-oriented model tools. A browser or local human attachment needs raw VT output, resize, reconnection, and explicit input ownership without weakening that Agent authorization. Binding the process to a browser connection would also make refresh, layout changes, and network loss terminate work that should continue.

Codex, Claude, a human shell, and a dsh-native Agent need one self-hosted workspace, but they do not share one interaction representation. Codex and Claude initially remain terminal-native workloads, while a dsh-native Agent retains its durable conversation, tool, approval, and subagent projections. Kitty can display a terminal attachment but cannot render that structured Agent state.

## Proposal

Add a Console capability whose Host-owned session contains one PTY, one top-level workload, raw output replay state, lifecycle status, and an exclusive input-and-geometry controller. Console sessions survive attachment loss and end only through explicit stop, top-level process exit, or provider teardown. Agent Terminal remains exact-Agent-owned and does not expose its handle or broaden its owner type.

The first provider spawns through `ctx.subprocess.spawnTerminal()`. The subprocess terminal handle exposes provider-neutral resize, and every provider joins or aborts an in-flight resize during termination. The first Console provider runs in the dsh Host process; its public interface must not assume that ownership remains in-process so a later independent daemon can preserve workloads across Host restarts.

Every attach, read, input, resize, signal, and stop operation authorizes a principal or unguessable capability in addition to a branded Console id. Multiple observers may receive output, but only the current controller may send input or resize the PTY. A remote viewer focusing a Console does not acquire control or change geometry.

Output uses monotonic sequence numbers and bounded retention. Reconnection receives a server-derived terminal snapshot and its sequence, followed by later deltas; a cursor outside retention produces an explicit resynchronization result. Terminal bytes do not enter the Agent session log or the connection-wide host event broadcast.

The initial remote consumer uses Typert RPC for control operations and capability-checked bounded long-poll reads. A dedicated duplex transport may replace the polling carrier when measured throughput requires it, while preserving the Console service's snapshot, delta, authorization, and controller semantics.

The Web Client initially adds one Human Console tile beside the current Agent conversation and renders only the focused tile on narrow devices. Device layout and focus are viewer state; Console lifecycle, attention, and control are shared Host state. Multiple simultaneous Agent tiles require a separate change that makes Client session providers addressable instead of binding every renderer to one current session.

Kitty remains an optional attachment launcher. A later integration opens or focuses a pane that runs `dsh console attach <console-id>`; Kitty does not own the PTY, authorize Console operations, or supply normal output replay.

## Package roles

- `dsh-console` defines Console identity, lifecycle, replay, authorization, control, and operations.
- `dsh-console-local` provides Host-local PTYs through the subprocess capability.
- `dsh-api-remotes` mounts the authorized Remote consumer.
- `dsh-ui-console` renders and controls a Console attachment in the Web Client.
- Later local-attach, Kitty, daemon, and tmux packages consume or provide the same capability without changing the default execution substrate.

## Alternatives considered

**Broaden Agent Terminal to `Agent | Human`.** Rejected because its exact live-Agent identity, line-oriented output, controlled prompt, and exclusive model send are deliberate guarantees. A union owner or raw-handle escape would make alternate callers bypass them.

**Let Kitty or a bridge process own every PTY.** Rejected because GUI lifecycle and physical keyboard input would bypass Host control, make remote operation depend on a Kitty session, and turn screen scraping into an unreliable output authority.

**Use tmux as the required provider.** Rejected because it transfers process, terminal, authorization, and teardown ownership to an external server before the product requires cross-Host persistence. It remains a valid optional provider.

**Send terminal bytes through the existing host event downlink.** Rejected because that stream broadcasts to every connected Client and does not authorize each Console capability. It also couples high-volume terminal traffic to Agent session reconnection.

**Parse Codex and Claude terminal interfaces into structured Agent sessions.** Rejected for the initial capability because filesystem and Git state are the reliable shared facts, while third-party TUI conversation formats are not stable integration contracts.

## Acceptance criteria

- A Web Human Shell starts a real PTY, accepts input and controller-owned resize, reconnects without restarting the process, and reaches process-tree quiescence after explicit stop.
- Console authorization rejects every read and mutation by a foreign principal or capability even when the caller knows the Console id.
- Observers receive ordered output without consuming each other's cursors; retention gaps produce an explicit snapshot resynchronization.
- Browser refresh, hidden tiles, remote disconnect, and Kitty attachment loss do not stop the workload.
- Agent Terminal exact-owner tests remain unchanged and passing.
- The shipped Web profile proves the behavior through real Loader, HTTP/RPC, PTY, and browser composition, with a keyless snapshot and a GUI recording.

## Risks

A Human Console is remote code execution. The Host must bind behind a strong external identity boundary, authorize every Console operation, scrub harness credentials from launcher environments, and keep session ids separate from authority.

An in-process local provider cannot preserve workloads across a Host crash. The first release states this lifecycle explicitly; an independent daemon is required before promising crash persistence.

Raw output retention is not a complete terminal state. The implementation needs a headless terminal snapshot or an equivalent deterministic reset-and-replay mechanism before it can claim arbitrary reconnect fidelity.

Bounded long-poll is simpler to authorize but may add latency or request overhead for high-throughput full-screen applications. Transport replacement must be driven by measurement and must retain the same authorization and replay semantics.
