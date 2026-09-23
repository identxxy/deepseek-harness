# Agent Note: Native plugin pane rendering

Status: implemented

English | [中文](2026-09-07-native-plugin-pane-rendering.zh.md)

## Problem

External terminal controls need the same navigation, input presentation and responsive layout as DSH conversations. Representing an existing Kitty pane as a DSH Agent or Console would assign session or process ownership that the plugin does not hold.

## Decision

The layout accepts a `panel` actor and renders its content through the root-scoped `workspace.panel` slot. Its identifier selects a plugin view; it is not a Session identifier. Pane layout persists on the device, while the plugin owns its selected external target and draft.

The keyed `workspace.panel.header` slot places the plugin's title and return action in the native pane bar, selected by actor ID. Layout keeps split and close controls and supplies a generic title when no matching header is registered. Kitty's window chooser owns creation and display options; a shared view store keeps those settings available to the terminal body.

Each pane renders a compact input area inside its own body, keeping the draft and send action next to their output. A shared canvas input would make its target depend on focus outside the input’s visual location. Kitty keeps drafts, staged images and send status in its root store by pane ID, so focus changes and split-tree remounts retain unfinished input. Every dispatch captures its pane and selection version; a late receipt updates only that selection, even if the user selects A, then B, then A again.

Agent panes share one editor per Session, so only the focused pane binds its root, keymap and decorators. Inactive panes show focusable draft mirrors; an editor cleanup detaches only the DOM root it still owns. Each mounted pane holds an independent persistence-mirror lease, including duplicate views of the same Session. Only the active composer captures document drops, and local drop handlers consume their batch before document intake. Compact inputs preserve output space by folding secondary controls rather than removing submission or permission capabilities.

Kitty occupies these slots and reuses conversation styles, UI primitives and attachment presentation. The attachment component accepts owner props and a translator without Session hooks; Kitty handles drops within its pane, with the component's document listeners disabled. Closing a pane unmounts its content without closing the external terminal.

Kitty shares the primary sidebar action slot and Console creation-button styles. Window creation is an authenticated, queued operation on the explicitly selected Kitty instance. It launches a default shell in the selected directory without taking focus; the returned window ID is resolved within that instance, because different Kitty instances can reuse IDs. Failed creation is not retried automatically.

External session browsers occupy keyed `sidebar.page` entries. The layout owns the transient page key and mobile destination together, so its browser history represents the main list, the plugin's window list and the selected terminal. Kitty owns its window catalog and keys each selection, follow state and trailing-Enter preference by the layout pane ID. A pane-local send preference prevents a checkbox in one terminal from changing submission behavior in another; individual key actions bypass that text-submission preference. One Send action also sends Enter for an empty draft, so terminal pickers can be confirmed without opening the key drawer. The checkbox has a visible text label on desktop and mobile to make text-only sending discoverable. Sidebar owner props carry the layout-owned focused ID; copying focus into a plugin store would give selection two competing targets. Returning to the list retains the selected window and draft. Choosing another window clears only the addressed pane’s draft and image, advances its selection version and remounts its screen reader. A new split inherits the last focused Kitty selection; retaining entries across layout remounts preserves the other panes when the split tree changes.

Layout persistence includes Agent Session IDs and the active pane. The first ready Session catalog establishes a selection baseline rather than an external selection: treating the restored global current Session as a user action would overwrite an independently restored Kitty, Console or Agent pane. Later sidebar selections still replace the focused pane. Mobile rendering preserves the full tree while showing its focused pane. Each explicit Session area supplies its own binding to nested slots and subscribes to availability, roster rebuilds and release independently from global selection; a late catalog can therefore populate restored Agent panes without changing focus.

Kitty persists only each pane’s non-credential `windowId` in origin-local browser storage and resolves it against a fresh catalog for a current token. The identity hashes the host boot ID, socket and inode, numeric window ID, creation information and root process identity; foreground processes and presentation fields cannot identify a durable window. Runtime restarts preserve this identity, while host restarts and replaced windows invalidate it even without creation timestamps. Title or numeric-ID matching could silently reconnect to another terminal, and persisting process-bound tokens would retain stale authorization. Missing windows require explicit selection; failed catalog reads retain the saved identity for retry. Restoration never sends input or persists tokens, drafts, staged images or trailing-Enter preferences.

Kitty's authenticated catalog starts through an index fetch preload, so its request overlaps plugin loading. Client activation consumes the preload and owns its pending read independently from view mounting. Opening the chooser shares a pending read or displays retained rows while refreshing; forced refresh cancels its predecessor and only the latest response publishes. Unload aborts and drains every catalog read. HTTP responses remain `no-store`, and an empty layout retains ordinary home navigation without selecting a terminal.

The browser's scroll edges delegate to Kitty's viewport through a bounded, queued `scroll-window` action followed by a screen read under the same pane token. Sending arrow keys would instead edit input or invoke the foreground application's commands. Snapshot replacement can detach the original touch node; gesture listeners stay on that node until the finger lifts so continuous swipes survive screen refreshes. Obsolete reads cannot publish after target or mode changes.

Pure horizontal-rule and Braille-only rows use single-line CSS clipping at the pane width. Star animations can change the text length and spacing on every snapshot; wrapping those rows changes the height of the output and displaces surrounding text. ANSI parsing classifies complete visible rows while retaining colors and links across newlines. CSS clips decoration without random sampling or font-width estimates, and mixed text remains wrappable.

Pane, split and preview identifiers use the shared cryptographic UUID helper. Direct `crypto.randomUUID` calls require a secure browser context and prevent these views from opening on private HTTP origins; the helper uses `crypto.getRandomValues`, which is available there.

## Alternatives considered

A separate overlay duplicates native navigation and composition styling. Reusing Agent or Console actors misstates ownership. Parsing terminal screens into model transcripts remains excluded for the reasons in [Host-owned Console Sessions](../../rejected/feature/2026-08-25-host-owned-console-sessions.md); the terminal screen is displayed as a snapshot.

**A terminal-header dropdown** makes mobile window switching depend on a compact form control and leaves the parent list outside browser history. **Replacing the workspace slot registration** removes its declared child slots. A separate keyed page keeps those declarations available while the shell selects the browsing content.

**Fetching the catalog only after a click** puts discovery and a network round trip after the entire plugin boot. A page-local preload overlaps those costs without persisting process-bound pane tokens or changing the all-plugin activation requirement.

## Consequences

Plugin views share native pane navigation without producing model-visible events. The single rendering slot has one occupant in this profile; additional view providers need explicit composition. Layout restoration and mounted rendering checks cover panel identity without Session staging; attachment checks cover disabling document drop capture.
