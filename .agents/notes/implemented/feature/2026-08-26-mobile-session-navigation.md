# Agent Note: Mobile Session Navigation Uses Browser History

Status: implemented

English | [中文](2026-08-26-mobile-session-navigation.zh.md)

## Problem

The desktop shell preserves simultaneous access to the Session browser, conversation, and details. Applying the same three-column model below the large breakpoint reduces the sidebar to a 56px rail, leaving the conversation squeezed and making the Session list an in-app panel toggle rather than a mobile navigation level. A phone user expects entering one conversation to use the full viewport and the platform back gesture to return to the list of conversations.

Session selection cannot itself represent that navigation. The blank New Session surface has no selected Session id, opening the currently selected Session is still a meaningful list-to-conversation gesture, and browser back must change the visible surface without clearing or reopening a runtime Session.

## Decision

`AppFrame` uses a single-pane layout below `MOBILE_NAV_BREAKPOINT` (1024px). The Session list and conversation remain mounted in their fixed grid positions, but exactly one receives the full frame width and the other is clipped at zero width. Details and both resize handles render at zero in this mode. At and above the breakpoint, the existing three-column solver, draggable widths, details concession, and 56px closed-sidebar rail remain unchanged.

The transient ui-layout store owns the responsive destination as `mobileView: 'auto' | 'sessions' | 'conversation'`. `auto` derives the first render from a DSH browser-History marker when one exists, otherwise from whether the runtime has a selected Session. Explicit `showSessionList` and `showConversation` actions represent user navigation without changing Session business state. Crossing the breakpoint resets only that responsive destination; desktop width preferences survive.

The first single-pane History entry is marked as the Session list through `replaceState`. Entering a conversation pushes a second entry with the same URL. `popstate` maps those markers back to layout actions, so platform edge-swipe, browser Back, and browser Forward move between list and conversation while the selected Session and both mounted React subtrees remain intact. Returning to the list through an in-app layout action calls `history.back()` when the current entry is the conversation child, avoiding duplicate list entries.

ui-sidebar requests the conversation destination after New Session. ui-workspace does the same after starting or opening a Session and after a fork successfully opens its child. These are view-navigation effects through `ctx.layout`; the runtime services remain the only owners of Session selection, creation, and fork state.

## Alternatives considered

**Keep the 56px rail on phones and let users expand it over the conversation.** This preserves one desktop interaction at every width, but the expanded sidebar competes with the conversation for the same narrow grid and platform Back still cannot express “all conversations.”

**Render the sidebar as a modal drawer above the conversation.** A drawer keeps the conversation mounted underneath and avoids History state. It makes the Session list a temporary overlay rather than the previous navigation level, so the phone's native back gesture either closes an implementation-specific layer or leaves the application depending on browser behavior.

**Encode the selected Session id in the URL and route between list and conversation pages.** Addressable Session URLs are useful independently, but they broaden the wire and reload contract and still do not cover the blank New Session surface. This change needs only local viewing state, so History markers keep the current URL and leave addressability for a separate decision.

**Unmount the inactive destination.** This gives the smallest DOM at phone widths, but returning to the Session list or conversation would reconstruct local scroll, search, composer, and disclosure state. Zero-width mounted tracks reuse the desktop shell's existing state-preservation rule.

## Consequences

- Phone-width use becomes a two-level navigation: a full Session list, then one full conversation. Browser Back returns to the list and Forward restores the conversation without a host request.
- Desktop splits, panel preferences, and the 56px rail retain their behavior because the mobile destination is ignored by the desktop solver.
- Browser History records only the list/conversation destination, not a Session id. Reload restores the runtime-selected Session independently and may therefore show a different conversation than an older History entry originally accompanied.
- The sidebar receives `{ collapsed: true, width: 0 }` while hidden on mobile. It remains mounted and completes its existing collapse transition inside the clipped track.
- Plugins that initiate Session navigation must call `ctx.layout.showConversation()` in addition to the relevant runtime action; ui-sidebar and ui-workspace provide the shipped entry points.

## Testing

ui-layout store, service, and AppFrame tests cover responsive destination transitions, same-value and breakpoint resets, zero/full-width owner props, no mobile drag handles, History push/back/pop behavior, and desktop width restoration. ui-sidebar and ui-workspace wiring tests cover the additional view-navigation effect for New Session, open, and fork.

`apps/web/tests/navigation-panes.e2e.ts` boots the shipped Web composition in Chromium at 390px, opens a cold Session from content search, records the list and conversation track geometry, and drives browser Back and Forward to verify both destinations in a real History implementation.
