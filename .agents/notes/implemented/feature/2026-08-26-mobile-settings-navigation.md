# Agent Note: Mobile Settings Use Two-Level Navigation

Status: implemented

English | [中文](2026-08-26-mobile-settings-navigation.zh.md)

## Problem

The Settings dialog keeps its 188px section navigation beside the active page at every viewport width. On a phone, the dialog is only the viewport width, so the navigation consumes most of the usable area while the settings controls are compressed into the remaining column. The desktop split remains useful and must not lose simultaneous navigation and content.

Phone navigation also needs a previous level. Selecting a Settings section is a viewing action, not a settings mutation, and the platform Back gesture must return to the section list without closing the dialog or changing any setting.

## Decision

Below 640px, the Settings dialog is a full-viewport single-pane surface. Opening Settings shows the complete section list. Selecting a row keeps both columns mounted, gives the selected section the full viewport width, and clips the navigation column at zero width. Returning to the list restores the full navigation column and clips the content column, preserving section-local form state. At wider viewports, the centered panel retains both columns.

The Settings shell pushes list and content entries under `__dshSettingsView` while preserving every unrelated field in the current browser History state. This includes `__dshMobileView`, owned by [mobile Session navigation](2026-08-26-mobile-session-navigation.md). `popstate` maps the content child back to the section list and maps the preceding non-Settings entry to a closed dialog. Close, mask, and Escape actions unwind one entry from the list or two from a section page.

An onboarding `openSection(id)` call creates the list parent before its requested content child, so platform Back has the same result whether the user entered Settings from the sidebar or onboarding. The responsive destination and History integration remain component-local viewing state inside `ui-settings-general`; Settings registrants continue to own their fields and mutations, with no slot or settings-service interface change.

## Alternatives considered

**Shrink the navigation rail but keep both columns visible.** Icons or shorter labels recover some width, but the content remains permanently narrower than the phone and section discovery becomes less legible.

**Replace the section rail with a top select or horizontal tabs.** A select hides the available categories, while tabs either scroll horizontally or truncate as plugins add sections. Both introduce a second mobile navigation vocabulary for the same list-to-detail relationship already used by Sessions.

**Render the navigation as a drawer over the settings page.** A drawer preserves full-width content but makes the section list a temporary overlay rather than the previous navigation level, so platform Back behavior depends on an extra disclosure state instead of the browser History stack.

## Consequences

- Phone Settings uses the complete viewport for either categories or one settings page; the inactive subtree stays mounted but is visually and accessibly hidden.
- A visible close control exists in both phone levels. Focus follows that control after History changes panes.
- Settings adds same-URL History entries. Other in-app History owners must preserve foreign state keys, and Settings does the same.
- CSS and JavaScript share the 640px threshold as a source-level invariant; changing the breakpoint requires updating both declarations together.
- Desktop opening, section selection, Escape, mask dismissal, panel geometry, and simultaneous navigation/content behavior remain unchanged.

## Testing

`settings-root.client.spec.tsx` covers phone detection, initial list state, foreign History-field preservation, section entry, Back/Forward projection, close-depth unwinding, visible-pane accessibility, and onboarding entry. `apps/web/tests/settings-chrome.e2e.ts` boots the shipped Web composition in Chromium at 390×844, records `390/0` and `0/390` column geometry, captures the localized category list, and drives browser Back and Forward.
