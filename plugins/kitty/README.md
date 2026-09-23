---
description: "Optional profile bundle for controlling existing local Kitty terminals."
kind: "package-bundle"
---

# @deepseek-ai/dsh-kitty

English | [中文](README.zh.md)

## Summary

Control an existing local Linux Kitty pane from the DSH sidebar. The native DSH conversation pane provides screen snapshots, text, keys and staged image attachments. This private workspace is optional and is not part of the shipped default profiles. It does not start Codex or register Agent tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Run from the repository root with Node ^22.19 or >=24:

```sh
pnpm install
pnpm run check:kitty
```

The check runs the plugin typecheck, focused tests and Host/Client build. Dependencies use pnpm workspace links; no adjacent checkout or manual peer-link script is required. Build outputs remain under `lib/` and are ignored by Git.

For local installation, add `@deepseek-ai/dsh-kitty` as a `link:` dependency pointing to this directory in the web profile package, and add that name to `dsh.profile.bundles`. Install the profile dependencies and restart `dsh --profile web`. The [patch](cordis.patch.yml) inserts `kitty-host`; set its `config.binary` to the Kitty executable path if the service PATH does not include it.

Open **Kitty terminal** to replace the sidebar session browser with **Kitty windows**. Each row shows its window ID, title, foreground program and working directory; click a row to enter that terminal. The native pane bar shows the selected window's title and back button. Desktop users can switch windows directly in the sidebar. Each pane has its own compact input row and retains its draft, staged image and trailing-Enter preference. The textarea starts at one line and grows with the draft; the ordinary row reserves no extra space for a target label or status. Each pane keeps its own terminal and follow state; sidebar selections replace only the focused pane. New splits initially show the focused Kitty terminal, and the sidebar highlight follows pane focus. On phones, the terminal's back button returns to the window list, and the list's back button returns to the main page. Browser back and forward follow the same hierarchy. Returning to the list retains the selected window and draft; selecting another window clears the draft and staged image.

The page preloads the authenticated window list while the interface loads. Opening the chooser reuses an in-flight read or displays retained rows while refreshing them. Manual refresh replaces the pending read; failed reads remain retryable. An empty layout opens the home page without selecting a Kitty window or sending terminal input.

Refreshing or reopening the page restores each pane’s Kitty window in the same browser origin. Restoration obtains a fresh token from the current catalog and sends no input. If the original window is closed or replaced, select another window; the plugin does not match by title or numeric window ID. A failed catalog read retains the saved target for a refresh retry. Drafts, staged images and the trailing-Enter preference reset on reload.

Desktop and mobile use one **Send** button with a labeled **Append newline** checkbox beside it. The checkbox defaults to checked: Send and Ctrl/⌘ Enter paste the draft, then send Enter. Uncheck it to omit that final Enter; line breaks already in the draft remain unchanged. With no text or staged image, Send and Ctrl/⌘ Enter send one Enter regardless of the checkbox. Each split pane retains its own choice across window selections until reload. Open **Terminal keys** (#) for **Alt + ↑** and the **↑ ↓ ← →** buttons. The direction buttons send individual direction keys without Enter and preserve the draft. **Alt + ↑** sends that shortcut to the selected terminal, including focusing pending Codex questions. The shortcut appears first on phones and preserves the draft. Choosing an image creates a removable preview; sending combines the image reference and caption in one paste. One image can be staged at a time. Clipboard image paste and file drop use the same flow.

The **Kitty terminal** button sits beside **New Terminal** in the sidebar’s primary actions and uses the same button styling. **New window** is available in the window chooser after selecting a terminal. It opens an independent Kitty OS window in that terminal's working directory with the default shell, preserves desktop focus and shows the new window ID in the chooser. Select that window after its shell starts. If the new shell is not listed yet, refresh the pane list; do not repeat creation. An existing local Kitty instance is required.

The screen wraps by default; terminal output and drafts use tighter line spacing on phones. Rows containing only horizontal separators or Braille characters and spaces stay one visual line, clipping overflow to the current pane width. Animated star positions cannot expand these rows; mixed text keeps ordinary wrapping. **Terminal options** in the window chooser expose original line width, scrollback and follow mode; these settings persist across window selections. Ctrl/⌘ Enter sends the draft; Enter in the textarea adds a newline. Closing the panel stops polling. Removing this bundle and dependency from the profile unloads the plugin without deleting CLI or DSH session data.

With **Include scrollback** off, wheel and single-finger gestures scroll the displayed text locally until its top or bottom edge. Continued motion scrolls the selected Kitty viewport and immediately reads its screen. **Latest output** returns Kitty to its live screen. With **Include scrollback** on, all scrolling stays in the browser. Scrolling preserves the draft; changing windows or modes discards pending gestures and cancels obsolete reads.

Click an HTTP(S) or `file://` link in the terminal to open **Browser** on the right. It reads the report from the DSH host, including local HTML reports with relative styles, images and scripts. Drag its left edge to resize, pin it to keep it open while using the terminal, or reopen it with the slim vertical **BROWSER** tab on the right edge. Desktop panes leave room for the tab so it cannot cover pane or input buttons. On phones, swipe the Browser title bar right to close it. Browser back dismisses the drawer before returning from the terminal to the window list and home; the drawer's own Back/Forward buttons navigate reports. Closing the drawer retains the terminal draft and current report.

The address bar and terminal links start a new report history. Links and GET forms inside a report remain within its real directory or HTTP origin; enter an address explicitly to choose another location. Relative GET/HEAD `fetch` calls use the same restriction. Failed navigation leaves the current report visible. Reports run in a sandbox without access to DSH's page or credentials.

### Configuration

| Field | Default |
| --- | --- |
| `binary` | `kitty` |
| `socketDirectory`, `socketPrefix` | `/tmp`, `kitty.sock-` |
| `timeoutMs`, `graceMs` | `20000`, `500` |
| `maxOutputBytes`, `maxTextBytes`, `maxImageBytes` | `4194304`, `131072`, `8388608` |
| `maxQueuedActions`, `pollIntervalMs` | `16`, `5000` |
| `scrollDebounceMs`, `maxScrollLines` | `70`, `80` |
| `scrollPixelsPerLine`, `touchScrollSensitivity` | `42`, `5` |
| `previewMaxBytes`, `previewMaxResources` | `67108864`, `64` |
| `previewAssetDirectories` | `[]` |
| `imageDirectory` | `~/Pictures/voxpress` |

`previewAssetDirectories` accepts an array of absolute directory paths. For local reports, Host HTML preparation may inline static images, posters, video and other resources from these explicitly configured directories. The default `[]` allows no extra directories. Iframe fetches and navigation remain confined to the selected report directory; HTTP reports cannot use this local-file permission. Opened files and symlinks must remain within an allowed real directory.

Directory configuration requires absolute paths. Images persist in UTC date subdirectories until user cleanup. Supported MIME types are PNG, JPEG, WebP, GIF, HEIC and HEIF. Configuration validation and defaults are owned by [local.mjs](local.mjs).

Scroll gestures accumulate for `scrollDebounceMs` before dispatch, with one request in flight and at most `maxScrollLines` per request. `scrollPixelsPerLine` converts pixels to lines; `touchScrollSensitivity` scales touch movement. Both accept positive fractions. A failed scroll clears pending movement; another gesture starts a new request. A scroll already accepted by the Host may finish after leaving the window.

Report reads use `timeoutMs`; `maxQueuedActions` also caps simultaneous preview requests. `previewMaxBytes` bounds source bytes, asset expansion and JSON output per request; base64 assets count toward the output limit. The default 64 MiB budget accommodates reports with embedded figures; larger reports require a higher configured limit. Browser distinguishes missing files, size-limit errors and an unavailable preview service. `previewMaxResources` caps document assets and redirects. Closing Browser cancels its requests; plugin disposal aborts and drains Host reads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Host and browser integration</summary>

The [Host](host-plugin.js) owns one [runtime](runtime.mjs), registers authenticated HTTP routes and executes Kitty through DSH subprocess. The [browser entry](src/client/index.ts) registers the sidebar. All requests pass the existing device gate and Connection Host/Origin/cookie checks. The non-credential `windowId` remains stable across runtime restarts and foreground, title or directory changes, using the host boot identity and the original window process. Pane tokens bind socket inode, creation information, PIDs and process start times; stale selections are rejected and input is queued. Unload aborts helper processes without closing user panes.

The Client occupies the keyed `sidebar.page` and `workspace.panel.header` entries and the `workspace.panel` body in the native layout. Each body renders its own `KittyComposer` addressed to that pane. The plugin stores terminal selection, draft, staged image, send status and follow state by layout pane ID; line-width and scrollback preferences and the authenticated catalog are shared. Input requests retain their original pane and selection version, so late receipts cannot clear a replacement draft. Only the pane-to-`windowId` mapping persists in origin-local browser storage; credentials and input state remain in memory. The shell owns responsive navigation and browser history. The terminal shares conversation/composer styles, buttons, icons and attachment presentation with DSH. Screen content is an ANSI terminal snapshot, not a structured DSH transcript.

The Host contributes a credential-matched fetch preload to the index. Client activation consumes that response without waiting for it before the rest of the UI mounts. Catalog reads remain `no-store` HTTP responses; retained rows belong only to the current page. The Client build minifies JavaScript outside development builds and preserves function and class names.

Image references use `[image](file://...)`: a leading exclamation mark invokes Codex shell mode. The ANSI renderer is adapted from the local Kitty Remote Deck implementation and rejects executable OSC hyperlinks.

The Browser drawer supports private-network HTTP pages as well as HTTPS pages.

The Browser uses `shell.overlay` and an opaque-origin `srcDoc` iframe. Its parent posts authenticated JSON to `/api/dsh/kitty/preview`; there is no executable report route or login bypass. The [reader](preview.mjs) signs a directory/origin restriction held only by the parent, checks file descriptors after opening regular Linux files, and validates each HTTP redirect. The [HTML/CSS preparation](preview-html.mjs) uses parse5 and css-tree to inline scoped assets. The [design note](../../.agents/notes/implemented/feature/2026-09-12-kitty-report-browser.md) records the transport and isolation choices.

</details>

## Further Exploration

[Profile composition](../../docs/architecture.md) · [Optional plugins](../README.md)

<a id="model-experience"></a>
## Model Experience

None. This plugin does not register model tools or change model requests, token use or KV-cache behavior. Input goes to the selected external terminal application.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Only local Linux Kitty is supported. Kitty viewport scrolling operates on the main screen and its history; alternate-screen applications manage their own internal scrolling. Kitty cannot atomically compare the foreground process and send input; a process can exit after validation. Dispatch receipts do not prove model receipt or completion, and failed mutations are never retried automatically. This plugin has no file download service, SSH targets, shared Cordis service or native Agent tools. An authorized browser Agent can use the UI; a native tool integration must share the runtime and add session-scoped authorization and logged results.

Browser previews HTML, text, images and bounded audio/video; it is not a full web proxy. External HTTP(S) CDN assets load from the viewing device. Upstream browser-cookie sessions, POST forwarding, WebSockets, XHR, JavaScript module import rewriting and PDF viewing are unsupported. Embedded frames/objects are omitted, and responsive images use their `src` fallback. Script-assigned navigation and dynamically inserted asset URLs do not pass through the report bridge.

## Dev Note

None.
