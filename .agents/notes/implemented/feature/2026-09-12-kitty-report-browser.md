# Agent Note: Kitty report Browser

Status: implemented

English | [中文](2026-09-12-kitty-report-browser.zh.md)

## Problem

Terminal links to local reports must work from a phone without abandoning the selected Kitty terminal. A sandboxed report has an opaque origin, so direct iframe requests cannot satisfy DSH's Origin and cookie checks. Serving report scripts at DSH's origin would expose the application to report code.

## Decision

The [Kitty plugin](../../../../plugins/kitty/README.md) opens a right-side Browser through `shell.overlay`, retaining the [native terminal pane](../architecture/2026-09-07-native-plugin-pane-rendering.md). Desktop resizing and mobile swipe dismissal leave its terminal selection and draft intact. The drawer has report history; the outer browser history dismisses it before leaving the terminal. Only the current document retains prepared HTML, while history stores addresses and access restrictions.

The authenticated parent requests JSON and installs prepared HTML in a sandboxed `srcDoc` iframe without `allow-same-origin`. Static scoped assets become data URLs through parse5 and css-tree. A per-document message channel and iframe source check route anchors, GET forms and read-only fetches through the parent. Device authentication and Connection checks apply to every Host request; no report HTML route bypasses them. The configurable byte budget accommodates embedded report figures and includes serialization overhead; a root-file-only limit would leave asset expansion unbounded. Missing files and size-limit failures have distinct UI messages.

An explicit terminal click or address submission selects a real file directory or HTTP origin. Host-signed restrictions stay in the parent and constrain iframe-initiated navigation and reads. File reads verify the opened Linux descriptor remains a regular file inside the selected directory; HTTP redirects remain on the selected origin. The Host enforces resource, byte and concurrency limits and drains cancelled reads on disposal.

Local reports can reference separately stored figures and videos through `previewAssetDirectories`, an explicit absolute-directory list that defaults to empty. Only Host static-asset preparation receives this additional permission; iframe fetches and navigation retain the signed report-directory restriction, root document reads gain no additional permission, and HTTP reports cannot use it. Descriptor checks reject symlinks escaping every allowed real directory. This allows report artifacts to remain separate from source documents without granting report scripts a broader file-reading API.

## Alternatives considered

**A separate tab or direct file link** makes phone access depend on the phone's filesystem and separates the report from the terminal draft. A drawer preserves the requested local-report workflow.

**A token-authenticated resource URL** lets an iframe load assets directly, but adds a credential-bearing URL and another authentication path. JSON through the parent reuses DSH's existing request checks and keeps executable report content off the application origin.

**A fresh scope for every iframe link** lets report code forge navigation to unrelated host files or services. Only explicit parent UI navigation can select another directory or origin; automatic navigation reuses the current restriction.

**Regex rewriting and a transparent web proxy** respectively miss valid HTML/CSS syntax and require substantially broader cookie, mutation and streaming semantics. Parser-based preparation supports local reports with bounded static assets and read-only requests. External CDN references remain browser resources.

## Consequences

Local reports retain script interaction without access to DSH's document or credentials. Inline assets incur base64 overhead, and the preview intentionally omits nested browsing contexts and full web-application proxying. The package README owns the supported formats and limits. Real Loader/browser cases cover local assets, fetch, iframe isolation, scoped navigation, draft retention, resize and mobile return; focused Host cases cover authentication, symlinks, redirects, FIFO rejection, cancellation and byte expansion.
