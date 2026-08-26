# Agent Note: tmux-backed Human Terminal actors

Status: proposed

English | [中文](2026-08-26-tmux-human-terminal-actors.zh.md)

## Problem

A self-hosted workspace needs model Agents and direct human terminals under one navigation and layout model. The existing persistent Terminal capability is intentionally owned by one exact live Agent and adapts a PTY to model tool calls; widening it to human callers would weaken its ownership, output, and cancellation guarantees. A Human Terminal also must outlive browser attachments and the dsh Host so a local Kitty client and remote Web clients can operate the same shell without Kitty becoming a server dependency.

The product calls both workloads actors, but a direct terminal has no model, prompt, inbox, turn, or agent loop. Registering it as a core `Agent` would make model lifecycle events and durable Session logs describe work that never occurred.

## Proposal

Treat a Human Terminal as a first-class product actor backed by the Console capability, not as a core `Agent`. The unified Workspace UI lists model Agent Sessions and Human Consoles together while each kind retains its own runtime and renderer. Agent conversations remain event-sourced; terminal bytes remain outside Session logs, telemetry, and the connection-wide Host event stream.

One Console identifies one DSH-owned tmux session. A separate Console Attachment identifies one ephemeral tmux client with its own bearer capability, terminal dimensions, output cursor, and idle cleanup. Every Web viewer receives a fresh attachment, so tmux draws the current screen directly and browser reconnect does not depend on replaying an arbitrary raw-byte history. Kitty attaches as another native tmux client and observes the same shell, processes, windows, panes, and input.

The tmux provider uses a configured dedicated tmux server rather than the user's default server. It starts under the subprocess seam's scrubbed environment, accepts only DSH-generated session names, records non-secret identity and Workspace metadata in tmux user options, and ignores sessions without valid DSH metadata. Console identity survives Host restart; process-local capabilities do not. Web and local CLI attachments suppress tmux environment updates so Harness credentials do not enter an existing session implicitly.

Creation publishes only after the detached tmux session and its metadata have been written and read back. Leaving a pane detaches its attachment. Archiving hides the Console but leaves the tmux session running. Explicit termination requires confirmation and kills the tmux session. Provider disposal and Host exit detach managed clients without killing Console workloads.

Desktop clients render addressable Agent and Console actors in resizable horizontal or vertical splits. The active pane receives ordinary Sidebar opens; an explicit action opens an actor in a new split. Layout state belongs to each Client device. Narrow clients render one focused actor and use browser history to return to the unified list. A local `dsh console attach <console-id>` command replaces its process with the native tmux client; it detects an existing tmux client instead of creating an unsupported nested attachment.

## Package roles

- `dsh-console` defines durable Console identity, ephemeral attachment identity, authorization, lifecycle, and provider operations.
- `dsh-console-tmux` provides DSH-owned tmux workloads and tmux-client attachments through the subprocess capability.
- `dsh-console-remote` exposes authorized list, create, attach, archive, terminate, attachment I/O, resize, signal, and detach operations.
- Client Console runtime and `dsh-ui-console` project Consoles into the unified Workspace actor list and render Web terminal panes.
- The CLI consumer resolves one Console id and executes the native tmux attachment without making Kitty a dependency.

## Alternatives considered

**Register a no-model core Agent.** Rejected because it must imitate inbox, turn, status, Session, and request behavior, making core Agent events and durable logs report a model lifecycle that does not exist.

**Broaden the Agent-owned Terminal capability to `Agent | Human`.** Rejected because exact live-Agent ownership, line-oriented model output, controlled prompts, and exclusive sends are deliberate guarantees. Human raw-terminal attachments require a separate capability.

**Keep one process-local PTY per Console.** This is the superseded [Host-owned Console proposal](../../rejected/feature/2026-08-25-host-owned-console-sessions.md). It cannot preserve a workload across Host restart and requires an additional terminal emulator or reset protocol to reconstruct arbitrary full-screen state. tmux already owns both persistence and redraw.

**Use one tmux session per Workspace and model Consoles as windows.** Rejected because Console lifecycle, archive, title, access, and termination would affect one shared container. One Console per tmux session preserves independent resource identity while still allowing windows and panes inside that Console.

**Import sessions from the user's default tmux server.** Rejected because DSH could not distinguish ownership or safely terminate resources. A dedicated server and DSH metadata keep ordinary tmux work outside product control.

**Share one Web tmux client among all viewers.** Rejected because dimensions, reconnect redraw, cursor retention, and attachment cleanup are viewer-specific. Ephemeral per-viewer attachments match tmux's native client model.

## Acceptance criteria

- A Human Terminal created in a registered Workspace starts one real session on the dedicated tmux server and appears beside Agent Sessions without creating a core Agent or model turn.
- The same Console accepts concurrent Web and native tmux attachments; input and screen updates are visible across clients, and detaching every client leaves the workload running.
- Restarting the dsh Host preserves the tmux workload and Console id, invalidates old process-local capabilities, and permits a fresh Web attachment with a complete screen redraw.
- Desktop clients can place Agent and Console actors in resizable splits; narrow clients focus one actor and return to the unified list through browser history.
- Archive, restore, detach, external termination, and explicit confirmed termination have distinct observable states and never kill unrelated tmux sessions.
- The provider does not inherit Harness credential-shaped environment variables, import arbitrary tmux sessions, interpolate remote values into shell commands, or store authority in tmux metadata.
- Real tmux integration, Host restart, remote authorization, GUI behavior, keyless snapshots, and existing Agent Terminal ownership tests cover the shipped composition.

## Risks

Human Terminal access is remote code execution and relies on the existing device-auth ingress plus per-attachment capabilities. A compromised enrolled device has the same shell authority as the user until its device credential is revoked.

tmux permits simultaneous clients to type into the same terminal. The product exposes this fact instead of claiming exclusive input ownership; users must avoid concurrent conflicting input. The configured tmux window-size policy also trades exact per-viewer geometry for a stable shared screen.

The tmux provider is unavailable where a compatible tmux executable and Unix-user socket permissions do not exist. The Human Terminal entry remains capability-driven so deployments without the provider omit it rather than presenting a broken control.

Long-poll transport may add overhead for high-throughput full-screen applications. A later duplex carrier may replace it only while preserving attachment authorization, bounded output, cancellation, and cleanup behavior.
