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

Open **Kitty terminal** to replace the sidebar session browser with **Kitty windows**. Each row shows its window ID, title, foreground program and working directory; click a row to enter that terminal. The native pane bar shows the selected window's title and back button. Desktop users can switch windows directly in the sidebar. On phones, the terminal's back button returns to the window list, and the list's back button returns to the main page. Browser back and forward follow the same hierarchy. Returning to the list retains the selected window and draft; selecting another window clears the draft and staged image.

The page preloads the authenticated window list while the interface loads. Opening the chooser reuses an in-flight read or displays retained rows while refreshing them. Manual refresh replaces the pending read; failed reads remain retryable. Opening the home page does not select a Kitty window or send terminal input.

Send submits the draft with Enter; Paste only leaves it in the terminal composer. Open **Terminal keys** and tap **Alt + ↑** to send that shortcut to the selected terminal, including focusing pending Codex questions. The shortcut appears first on phones and preserves the draft. Choosing an image creates a removable preview; sending combines the image reference and caption in one paste. One image can be staged at a time. Clipboard image paste and file drop use the same flow.

The **Kitty terminal** button sits beside **New Terminal** in the sidebar’s primary actions and uses the same button styling. **New window** is available in the window chooser after selecting a terminal. It opens an independent Kitty OS window in that terminal's working directory with the default shell, preserves desktop focus and shows the new window ID in the chooser. Select that window after its shell starts. If the new shell is not listed yet, refresh the pane list; do not repeat creation. An existing local Kitty instance is required.

The screen wraps by default; terminal output and drafts use tighter line spacing on phones. **Terminal options** in the window chooser expose original line width, scrollback and follow mode; these settings persist across window selections. Ctrl/⌘ Enter sends the draft; Enter in the textarea adds a newline. Closing the panel stops polling. Removing this bundle and dependency from the profile unloads the plugin without deleting CLI or DSH session data.

Click an HTTP(S) or `file://` link in the terminal to open **Browser** on the right. It reads the report from the DSH host, including local HTML reports with relative styles, images and scripts. Drag its left edge to resize, pin it to keep it open while using the terminal, or reopen it with the slim vertical **BROWSER** tab on the right edge. On phones, swipe the Browser title bar right to close it. Browser back dismisses the drawer before returning from the terminal to the window list and home; the drawer's own Back/Forward buttons navigate reports. Closing the drawer retains the terminal draft and current report.

The address bar and terminal links start a new report history. Links and GET forms inside a report remain within its real directory or HTTP origin; enter an address explicitly to choose another location. Relative GET/HEAD `fetch` calls use the same restriction. Failed navigation leaves the current report visible. Reports run in a sandbox without access to DSH's page or credentials.

### Configuration

| Field | Default |
| --- | --- |
| `binary` | `kitty` |
| `socketDirectory`, `socketPrefix` | `/tmp`, `kitty.sock-` |
| `timeoutMs`, `graceMs` | `20000`, `500` |
| `maxOutputBytes`, `maxTextBytes`, `maxImageBytes` | `4194304`, `131072`, `8388608` |
| `maxQueuedActions`, `pollIntervalMs` | `16`, `5000` |
| `previewMaxBytes`, `previewMaxResources` | `67108864`, `64` |
| `imageDirectory` | `~/Pictures/voxpress` |

Directory configuration requires absolute paths. Images persist in UTC date subdirectories until user cleanup. Supported MIME types are PNG, JPEG, WebP, GIF, HEIC and HEIF. Configuration validation and defaults are owned by [local.mjs](local.mjs).

Report reads use `timeoutMs`; `maxQueuedActions` also caps simultaneous preview requests. `previewMaxBytes` bounds source bytes, asset expansion and JSON output per request; base64 assets count toward the output limit. The default 64 MiB budget accommodates reports with embedded figures; larger reports require a higher configured limit. Browser distinguishes missing files, size-limit errors and an unavailable preview service. `previewMaxResources` caps document assets and redirects. Closing Browser cancels its requests; plugin disposal aborts and drains Host reads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Host and browser integration</summary>

The [Host](host-plugin.js) owns one [runtime](runtime.mjs), registers authenticated HTTP routes and executes Kitty through DSH subprocess. The [browser entry](src/client/index.ts) registers the sidebar. All requests pass the existing device gate and Connection Host/Origin/cookie checks. Pane tokens bind socket inode, creation information, PIDs and process start times; stale selections are rejected and input is queued. Unload aborts helper processes without closing user panes.

The Client occupies the keyed `sidebar.page` and `workspace.panel.header` entries and the `workspace.panel` body in the native layout. These views share transient window selection, display settings and an authenticated catalog source. The shell owns responsive navigation and browser history. The terminal shares conversation/composer styles, buttons, icons and attachment presentation with DSH. Screen content is an ANSI terminal snapshot, not a structured DSH transcript.

The Host contributes a credential-matched fetch preload to the index. Client activation consumes that response without waiting for it before the rest of the UI mounts. Catalog reads remain `no-store` HTTP responses; retained rows belong only to the current page. The Client build minifies JavaScript outside development builds and preserves function and class names.

Image references use `[image](file://...)`: a leading exclamation mark invokes Codex shell mode. The ANSI renderer is adapted from the local Kitty Remote Deck implementation and rejects executable OSC hyperlinks.

The Browser uses `shell.overlay` and an opaque-origin `srcDoc` iframe. Its parent posts authenticated JSON to `/api/dsh/kitty/preview`; there is no executable report route or login bypass. The [reader](preview.mjs) signs a directory/origin restriction held only by the parent, checks file descriptors after opening regular Linux files, and validates each HTTP redirect. The [HTML/CSS preparation](preview-html.mjs) uses parse5 and css-tree to inline scoped assets. The [design note](../../.agents/notes/implemented/feature/2026-09-12-kitty-report-browser.md) records the transport and isolation choices.

</details>

## Further Exploration

[Profile composition](../../docs/architecture.md) · [Optional plugins](../README.md)

<a id="model-experience"></a>
## Model Experience

None. This plugin does not register model tools or change model requests, token use or KV-cache behavior. Input goes to the selected external terminal application.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Only local Linux Kitty is supported. Kitty cannot atomically compare the foreground process and send input; a process can exit after validation. Dispatch receipts do not prove model receipt or completion, and failed mutations are never retried automatically. This plugin has no file download service, SSH targets, shared Cordis service or native Agent tools. An authorized browser Agent can use the UI; a native tool integration must share the runtime and add session-scoped authorization and logged results.

Browser previews HTML, text, images and bounded audio/video; it is not a full web proxy. External HTTP(S) CDN assets load from the viewing device. Upstream browser-cookie sessions, POST forwarding, WebSockets, XHR, JavaScript module import rewriting and PDF viewing are unsupported. Embedded frames/objects are omitted, and responsive images use their `src` fallback. Script-assigned navigation and dynamically inserted asset URLs do not pass through the report bridge.

## Dev Note

None.
