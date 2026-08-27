# Secure remote access

English | [中文](remote-access.zh.md)

This guide publishes the DSH Web UI through a remotely managed Cloudflare Tunnel while keeping the origin on loopback. Cloudflare Access verifies the email owner only at device enrollment; the DSH device-auth plugin protects every other public HTTP request and WebSocket upgrade with a long-lived device credential.

## Security model

```text
Browser HTTPS
  -> Cloudflare edge
    -> Access on /auth/device/enroll only
      -> outbound Cloudflare Tunnel
        -> http://127.0.0.1:3080
          -> DSH device authentication
```

The layers have separate jobs:

- DSH listens only on `127.0.0.1`, so the host exposes no application port to its LAN or public network.
- Cloudflare Tunnel creates outbound connections and maps one public hostname to the loopback service. Possession of its tunnel token lets another connector join that tunnel, so the token stays outside Git with mode `0600`.
- Cloudflare Access protects the exact enrollment path and supplies the signed `Cf-Access-Jwt-Assertion` that DSH verifies. It does not protect the rest of the hostname in this design.
- DSH device authentication protects normal pages, APIs, unsafe methods, and WebSocket upgrades. `--trusted-host` is a Host-header and DNS-rebinding fence, not authentication.
- A permanent device token is portable bearer material, not MAC-address binding or hardware attestation. Store it like a password and enroll separate physical devices separately.

The checked-in [Cloudflare dashboard values](../../../examples/deployment/cloudflare/cloudflare-dashboard.yml.example), [cloudflared unit](../../../examples/deployment/cloudflare/cloudflared.service.example), [DSH unit](../../../examples/deployment/cloudflare/dsh-web.service.example), and [Cordis overlay](../../../examples/deployment/cloudflare/device-auth.cordis.yml.example) contain placeholders only. Keep deployment-specific values and credentials in machine-local files.

## Prerequisites

- A hostname in a Cloudflare-managed DNS zone.
- A remotely managed Cloudflare Tunnel and `cloudflared` 2025.4.0 or newer; that is the first release supporting `--token-file`.
- A DSH installation that can run `dsh web` and install profile bundles.
- One email address allowed to enroll devices. The same exact address must appear in the Cloudflare Access policy and the DSH plugin config.

Cloudflare documents [published application routes](https://developers.cloudflare.com/tunnel/setup/), [`--token-file`](https://developers.cloudflare.com/tunnel/advanced/run-parameters/#token-file), [path-scoped Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), and [email OTP login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/). This guide uses the dashboard-managed route and token model; do not combine it with a locally managed tunnel `config.yml` and credentials JSON.

## Install and configure device authentication

Install the complete optional bundle into the Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-host-device-auth-web
```

Merge the row from `device-auth.cordis.yml.example` into `$DSH_HOME/profiles/web/cordis.patch.yml`; when `DSH_HOME` is unset, DSH uses `~/.dsh`. A profile patch replaces the target row's entire `config`, so keep all six fields together.

Replace these values:

- `publicOrigin`: the exact public HTTPS origin, with no trailing slash.
- `accessIssuer`: the exact Cloudflare Access team origin, usually `https://<team-name>.cloudflareaccess.com`.
- `accessAudience`: the Access application's AUD tag.
- `accessEmail`: the exact email allowed by the Access policy.

`accessClockToleranceSeconds` and `maxFormBytes` are deployment tunables; the template uses conservative values. The [device-auth Web package reference](../../../packages/host/device-auth-web/README.md) owns the complete plugin behavior and config requirements.

## Run DSH on loopback

Copy `dsh-web.service.example` to `~/.config/systemd/user/dsh-web.service`. Replace the working directory with the workspace that agents may access, replace `dsh.example.com` with the public hostname, and ensure the unit's `PATH` contains the directory reported by `dirname "$(command -v dsh)"`. Alternatively, replace `/usr/bin/env dsh` with the executable's absolute path.

Do not run DSH as root. The process executes agents and human terminals with the account permissions of the service user; `WorkingDirectory` is also the default filesystem context.

Load and start the user unit:

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service
systemctl --user status dsh-web.service
```

Enable systemd user lingering if the service must start at boot before an interactive login. Check the host's local policy before enabling it.

The public hostname must be passed through `--trusted-host`. Keep `--host 127.0.0.1`; binding an agent harness to every interface would bypass the tunnel-only reachability design.

## Publish the tunnel

In **Cloudflare Dashboard → Networking → Tunnels**, create or select a remotely managed tunnel. Add a Published application route with the values from `cloudflare-dashboard.yml.example`: public hostname `dsh.example.com`, service `http://127.0.0.1:3080`.

Create the token file without putting the token in shell history:

```sh
mkdir -p ~/.cloudflared
chmod 700 ~/.cloudflared
touch ~/.cloudflared/dsh-tunnel-token
chmod 600 ~/.cloudflared/dsh-tunnel-token
${EDITOR:-vi} ~/.cloudflared/dsh-tunnel-token
```

Paste only the tunnel token value, not the surrounding `cloudflared` installation command, then save the file.

Copy `cloudflared.service.example` to `~/.config/systemd/user/cloudflared-dsh.service`. Replace `/usr/bin/cloudflared` if `command -v cloudflared` reports another absolute path, then start it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-dsh.service
systemctl --user status cloudflared-dsh.service
```

The unit reads the token with `--token-file`; it does not contain the token and does not need `cert.pem`. Configure the public hostname route in the dashboard, not in a local `config.yml`.

## Protect enrollment with Cloudflare Access

Create one self-hosted Access application for the exact application path `dsh.example.com/auth/device/enroll`. Do not protect the entire hostname unless you intentionally want Cloudflare login to remain mandatory for every DSH request.

Create an Allow policy with both conditions:

- **Include → Emails**: the exact enrollment email.
- **Require → Login Methods**: One-time PIN, or the identity provider you intend to use.

Do not use **Include → Login Methods → One-time PIN** by itself: Cloudflare documents that this permits any valid email user. Copy the application's AUD tag, the team issuer origin, and the exact email into the DSH Cordis overlay. DSH verifies the Access JWT signature through the issuer JWKS and checks issuer, audience, expiration, subject, and exact email; a Cloudflare login page alone is not sufficient.

## Add hostname-scoped HTTPS rules

Create an HTTP-to-HTTPS Redirect Rule restricted to `dsh.example.com`, preserving the request path and query string. Create a Response Header Transform Rule for the same hostname that sets:

```text
Strict-Transport-Security: max-age=31536000
```

The template intentionally omits `includeSubDomains` and `preload`; enabling either affects names outside this application and requires a separate domain-wide decision. Apply both rules only after HTTPS works.

## Enroll and use a device

1. On the new device, open `https://dsh.example.com/auth/device/enroll`.
2. Complete the Cloudflare email or identity-provider check, enter a device label, and submit the form.
3. Save the permanent device token displayed once in a password manager. Enrollment also sets the Secure, HttpOnly, SameSite=Strict browser-session cookie, so returning to the DSH root works immediately.
4. If the browser session is missing later, open `/auth/device/login` and exchange the permanent token for a new session.

The shipped provider uses a one-year rolling browser-session idle lifetime and renews when less than 30 days remain. The permanent token has no time-based expiry; rotation or revocation invalidates it. Each enrolled device has at most one active browser session, so logging in with the same permanent token in another browser replaces the previous session. Enroll a phone and desktop as separate devices instead of sharing one token.

## Manage enrolled devices

The administration page is intentionally local-only. It requires both a loopback TCP peer and a loopback Host; the public hostname remains authenticated even though `cloudflared` connects from loopback.

When DSH runs on another server, forward a local port over SSH:

```sh
ssh -N -L 3081:127.0.0.1:3080 operator@server.example
```

Open `http://127.0.0.1:3081/auth/device/admin`. The page lists secret-free device records and supports revocation and permanent-token rotation. Rotation invalidates that device's active browser session and displays the replacement token once; use the replacement at `/auth/device/login`.

## Verify the deployment

First verify that only loopback owns the application port and both services are running:

```sh
ss -ltnp '( sport = :3080 )'
systemctl --user is-active dsh-web.service cloudflared-dsh.service
```

Then run the network checks from a shell that has no DSH browser cookie:

```sh
DSH_PUBLIC_HOST=dsh.example.com

# Local loopback bypass reaches the application.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/

# A public Host over the loopback tunnel path still requires device auth.
curl -sS -o /dev/null -w '%{http_code}\n' -H "Host: ${DSH_PUBLIC_HOST}" http://127.0.0.1:3080/

# An untrusted Host is rejected before application dispatch.
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: invalid.example.com' http://127.0.0.1:3080/

# The edge redirects HTTP and emits HSTS over HTTPS.
curl -sSI "http://${DSH_PUBLIC_HOST}/probe?value=1"
curl -sSI "https://${DSH_PUBLIC_HOST}/" | grep -i '^strict-transport-security:'
```

The expected status sequence for the first three requests is `200`, `401`, and `403`. The HTTP response must redirect to the same path and query on HTTPS, and the HTTPS response must carry the configured HSTS value. Finally, enroll a disposable browser profile, load the Web UI, start one request, and confirm that its WebSocket remains connected.

## Credential lifecycle and rollback

- Suspected tunnel-token exposure: rotate the remotely managed tunnel token in Cloudflare, replace the local token file, and restart every connector replica.
- Lost or compromised device: open the local administration page and revoke it. Rotate instead when the device remains trusted but its permanent token needs replacement.
- Browser-only compromise: logging in again with the permanent token replaces the single active session; rotating the permanent token provides a stronger reset.
- Full rollback: disable `cloudflared-dsh.service`, remove the published application route and Access application, remove the hostname-scoped edge rules, then disable `dsh-web.service`. Remove the optional bundle with `dsh plugin --profile web remove @deepseek-ai/dsh-host-device-auth-web` only if local device authentication is no longer needed.

## Troubleshooting

- **Enrollment returns 403**: confirm that Access protects the exact enrollment path and sends `Cf-Access-Jwt-Assertion`; then compare issuer, AUD, and email with the complete DSH config row.
- **The public root returns 401**: the request has no valid DSH browser session. Enroll the browser or sign in with that device's permanent token.
- **The public root returns 403**: compare the request Host and Origin with `publicOrigin`, and confirm that `--trusted-host` names the public hostname.
- **Cloudflare returns 502**: confirm that DSH is active on `127.0.0.1:3080` and the tunnel route uses the same service URL.
- **The administration page returns 403**: reach it through loopback or an SSH local forward and use a loopback URL in the browser; it is unavailable through the public hostname by design.
