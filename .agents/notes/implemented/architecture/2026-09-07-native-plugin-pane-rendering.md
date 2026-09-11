# Agent Note: Native plugin pane rendering

Status: implemented

English | [中文](2026-09-07-native-plugin-pane-rendering.zh.md)

## Problem

External terminal controls need the same navigation, input presentation and responsive layout as DSH conversations. Representing an existing Kitty pane as a DSH Agent or Console would assign session or process ownership that the plugin does not hold.

## Decision

The layout accepts a `panel` actor and renders its content through the root-scoped `workspace.panel` slot. Its identifier selects a plugin view; it is not a Session identifier. Pane layout persists on the device, while the plugin owns its selected external target and draft.

The keyed `workspace.panel.header` slot places the plugin's title and return action in the native pane bar, selected by actor ID. Layout keeps split and close controls and supplies a generic title when no matching header is registered. Kitty's window chooser owns creation and display options; a shared view store keeps those settings available to the terminal body.

Kitty occupies this slot and reuses conversation styles, UI primitives and attachment presentation. The attachment component accepts owner props and a translator without Session hooks; Kitty handles drops within its pane, with the component's document listeners disabled. Closing a pane unmounts its content without closing the external terminal.

Kitty shares the primary sidebar action slot and Console creation-button styles. Window creation is an authenticated, queued operation on the explicitly selected Kitty instance. It launches a default shell in the selected directory without taking focus; the returned window ID is resolved within that instance, because different Kitty instances can reuse IDs. Failed creation is not retried automatically.

External session browsers occupy keyed `sidebar.page` entries. The layout owns the transient page key and mobile destination together, so its browser history represents the main list, the plugin's window list and the selected terminal. Kitty owns its window catalog and selection; returning to its list retains the selected window and draft. Choosing another window remounts the terminal body to discard the previous draft, image and screen request.

## Alternatives considered

A separate overlay duplicates native navigation and composition styling. Reusing Agent or Console actors misstates ownership. Parsing terminal screens into model transcripts remains excluded for the reasons in [Host-owned Console Sessions](../../rejected/feature/2026-08-25-host-owned-console-sessions.md); the terminal screen is displayed as a snapshot.

**A terminal-header dropdown** makes mobile window switching depend on a compact form control and leaves the parent list outside browser history. **Replacing the workspace slot registration** removes its declared child slots. A separate keyed page keeps those declarations available while the shell selects the browsing content.

## Consequences

Plugin views share native pane navigation without producing model-visible events. The single rendering slot has one occupant in this profile; additional view providers need explicit composition. Layout restoration and mounted rendering checks cover panel identity without Session staging; attachment checks cover disabling document drop capture.
