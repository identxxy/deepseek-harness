# 安全远程访问

[English](remote-access.md) | 中文

本指南通过 remotely-managed Cloudflare Tunnel 发布 DSH Web UI，同时让源站只监听 loopback。Cloudflare Access 仅在设备注册时验证邮箱所有者；DSH 设备认证插件使用长期设备凭据保护其他所有公开 HTTP 请求和 WebSocket upgrade。

## 安全模型

```text
Browser HTTPS
  -> Cloudflare edge
    -> Access on /auth/device/enroll only
      -> outbound Cloudflare Tunnel
        -> http://127.0.0.1:3080
          -> DSH device authentication
```

各层分别承担以下职责：

- DSH 只监听 `127.0.0.1`，因此主机不会向局域网或公网暴露应用端口。
- Cloudflare Tunnel 建立出站连接，并把一个公开 hostname 映射到 loopback 服务。持有 tunnel token 的主体可以让另一个 connector 加入该 tunnel，因此 token 必须留在 Git 外，文件 mode 设为 `0600`。
- Cloudflare Access 保护精确的注册路径，并提供由 DSH 验证的签名 `Cf-Access-Jwt-Assertion`。本设计不让它保护 hostname 的其余路径。
- DSH 设备认证保护普通页面、API、不安全方法和 WebSocket upgrade。`--trusted-host` 是 Host header 与 DNS rebinding 栅栏，不是认证。
- 永久设备 token 是可移植的 bearer material，不是 MAC 地址绑定或 hardware attestation。请像密码一样保存它，并分别注册不同的物理设备。

仓库中的 [Cloudflare dashboard 参数](../../../examples/deployment/cloudflare/cloudflare-dashboard.yml.example)、[cloudflared unit](../../../examples/deployment/cloudflare/cloudflared.service.example)、[DSH unit](../../../examples/deployment/cloudflare/dsh-web.service.example)和 [Cordis overlay](../../../examples/deployment/cloudflare/device-auth.cordis.yml.example)只含占位符。请把部署值和凭据保存在机器本地文件中。

## 前置条件

- Cloudflare 托管的 DNS zone 中有一个 hostname。
- 一个 remotely-managed Cloudflare Tunnel，以及 2025.4.0 或更新版本的 `cloudflared`；该版本首次支持 `--token-file`。
- 一份可以运行 `dsh web` 并安装 profile bundle 的 DSH 安装。
- 一个允许注册设备的邮箱地址。Cloudflare Access 策略与 DSH 插件配置必须使用完全相同的地址。

Cloudflare 分别记录了[published application route](https://developers.cloudflare.com/tunnel/setup/)、[`--token-file`](https://developers.cloudflare.com/tunnel/advanced/run-parameters/#token-file)、[path-scoped Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)和[邮箱 OTP 登录](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)。本指南使用 dashboard 管理的 route 与 token 模式；不要将其与 locally-managed tunnel 的 `config.yml` 和 credentials JSON 混用。

## 安装并配置设备认证

把完整的可选 bundle 安装到 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-host-device-auth-web
```

把 `device-auth.cordis.yml.example` 中的 row 合并到 `$DSH_HOME/profiles/web/cordis.patch.yml`；若未设置 `DSH_HOME`，DSH 使用 `~/.dsh`。profile patch 会替换目标 row 的整个 `config`，因此需要同时保留全部 6 个字段。

替换以下值：

- `publicOrigin`：精确的公开 HTTPS origin，不带末尾斜杠。
- `accessIssuer`：精确的 Cloudflare Access team origin，通常是 `https://<team-name>.cloudflareaccess.com`。
- `accessAudience`：Access application 的 AUD tag。
- `accessEmail`：Access 策略允许的精确邮箱地址。

`accessClockToleranceSeconds` 与 `maxFormBytes` 是部署调节项；模板采用保守值。[device-auth Web 包参考](../../../packages/host/device-auth-web/README.zh.md)负责描述完整的插件行为与配置要求。

## 让 DSH 监听 loopback

把 `dsh-web.service.example` 复制到 `~/.config/systemd/user/dsh-web.service`。把 working directory 替换为允许 agent 访问的 workspace，用公开 hostname 替换 `dsh.example.com`，并确认 unit 的 `PATH` 包含 `dirname "$(command -v dsh)"` 返回的目录。也可以用可执行文件的绝对路径替换 `/usr/bin/env dsh`。

不要以 root 身份运行 DSH。进程会使用 service user 的账户权限执行 agent 和 human terminal；`WorkingDirectory` 也是默认文件系统上下文。

加载并启动 user unit：

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service
systemctl --user status dsh-web.service
```

如果服务必须在交互式登录前随系统启动，请启用 systemd user lingering。启用前先确认主机的本地策略。

必须通过 `--trusted-host` 传入公开 hostname。保持 `--host 127.0.0.1`；如果让 agent harness 绑定全部 interface，就会绕过本设计只允许 tunnel 到达应用的约束。

## 发布 tunnel

在 **Cloudflare Dashboard → Networking → Tunnels** 中创建或选择 remotely-managed tunnel。使用 `cloudflare-dashboard.yml.example` 中的值添加 Published application route：公开 hostname 为 `dsh.example.com`，service 为 `http://127.0.0.1:3080`。

创建 token 文件，不要让 token 进入 shell history：

```sh
mkdir -p ~/.cloudflared
chmod 700 ~/.cloudflared
touch ~/.cloudflared/dsh-tunnel-token
chmod 600 ~/.cloudflared/dsh-tunnel-token
${EDITOR:-vi} ~/.cloudflared/dsh-tunnel-token
```

只粘贴 tunnel token 的值，不要粘贴外围的 `cloudflared` 安装命令，然后保存文件。

把 `cloudflared.service.example` 复制到 `~/.config/systemd/user/cloudflared-dsh.service`。如果 `command -v cloudflared` 返回另一个绝对路径，请替换 `/usr/bin/cloudflared`，然后启动服务：

```sh
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-dsh.service
systemctl --user status cloudflared-dsh.service
```

unit 通过 `--token-file` 读取 token；unit 自身不包含 token，也不需要 `cert.pem`。请在 dashboard 中配置公开 hostname route，而不是在本地 `config.yml` 中配置。

## 使用 Cloudflare Access 保护注册路径

为精确的 application path `dsh.example.com/auth/device/enroll` 创建一个 self-hosted Access application。除非你有意要求每个 DSH 请求都必须经过 Cloudflare 登录，否则不要保护整个 hostname。

创建同时包含以下两个条件的 Allow 策略：

- **Include → Emails**：精确的注册邮箱。
- **Require → Login Methods**：One-time PIN，或你计划使用的 identity provider。

不要单独使用 **Include → Login Methods → One-time PIN**：Cloudflare 文档明确说明，该写法会允许任何具有有效邮箱的用户。把 application 的 AUD tag、team issuer origin 和精确邮箱复制到 DSH Cordis overlay。DSH 会通过 issuer JWKS 验证 Access JWT 签名，并检查 issuer、audience、expiration、subject 与精确邮箱；只看到 Cloudflare 登录页并不足以完成验证。

## 添加 hostname-scoped HTTPS 规则

创建仅限 `dsh.example.com` 的 HTTP-to-HTTPS Redirect Rule，并保留请求 path 与 query string。再为相同 hostname 创建 Response Header Transform Rule，设置：

```text
Strict-Transport-Security: max-age=31536000
```

模板有意不包含 `includeSubDomains` 与 `preload`；启用任一选项都会影响本应用以外的名称，需要单独作出 domain-wide 决策。请在 HTTPS 正常工作后再应用这两个规则。

## 注册并使用设备

1. 在新设备上打开 `https://dsh.example.com/auth/device/enroll`。
2. 完成 Cloudflare 邮箱或 identity-provider 检查，输入设备 label，然后提交表单。
3. 把只显示一次的永久设备 token 保存到密码管理器。注册还会设置 Secure、HttpOnly、SameSite=Strict browser-session cookie，因此返回 DSH 根页面后可以立即使用。
4. 如果之后缺少 browser session，请打开 `/auth/device/login`，用永久 token 交换一个新 session。

随包提供的 provider 使用 1 年滚动 browser-session idle lifetime，并在剩余时间少于 30 天时续期。永久 token 没有按时间计算的过期时间；rotation 或 revocation 会使它失效。每个已注册设备最多只有一个 active browser session，因此在另一个 browser 中使用相同永久 token 登录，会替换前一个 session。请把手机与桌面注册成不同设备，不要共享一个 token。

## 管理已注册设备

管理页面有意限制为仅本地访问。它同时要求 loopback TCP peer 和 loopback Host；虽然 `cloudflared` 从 loopback 连接，公开 hostname 仍然必须通过认证。

当 DSH 运行在另一台服务器上时，通过 SSH 转发一个本地端口：

```sh
ssh -N -L 3081:127.0.0.1:3080 operator@server.example
```

打开 `http://127.0.0.1:3081/auth/device/admin`。该页面列出不含 secret 的设备记录，并支持 revocation 和永久 token rotation。rotation 会使该设备的 active browser session 失效，并只显示一次替代 token；请在 `/auth/device/login` 使用替代 token。

## 验证部署

首先确认只有 loopback 占用应用端口，且两个 service 都在运行：

```sh
ss -ltnp '( sport = :3080 )'
systemctl --user is-active dsh-web.service cloudflared-dsh.service
```

然后从不含 DSH browser cookie 的 shell 运行网络检查：

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

前三个请求的预期状态码依次是 `200`、`401` 和 `403`。HTTP 响应必须重定向到 HTTPS 下相同的 path 与 query，HTTPS 响应必须携带配置的 HSTS 值。最后，在一次性 browser profile 中注册设备、加载 Web UI、发起一个请求，并确认其 WebSocket 保持连接。

## 凭据生命周期与回滚

- 怀疑 tunnel token 泄露：在 Cloudflare 中 rotation remotely-managed tunnel token，替换本地 token 文件，并重启每个 connector replica。
- 设备丢失或被攻破：打开本地管理页面并 revoke 该设备。如果设备仍可信、只是需要替换永久 token，则执行 rotation。
- 仅 browser 被攻破：再次使用永久 token 登录会替换唯一的 active session；rotation 永久 token 可以完成更彻底的重置。
- 完整回滚：disable `cloudflared-dsh.service`，删除 Published application route 与 Access application，删除 hostname-scoped edge rule，然后 disable `dsh-web.service`。只有不再需要本地设备认证时，才运行 `dsh plugin --profile web remove @deepseek-ai/dsh-host-device-auth-web` 删除可选 bundle。

## 排错

- **注册返回 403**：确认 Access 保护精确的注册路径并发送 `Cf-Access-Jwt-Assertion`；然后对照完整 DSH 配置 row 检查 issuer、AUD 与 email。
- **公开根页面返回 401**：请求不含有效 DSH browser session。请注册该 browser，或使用该设备的永久 token 登录。
- **公开根页面返回 403**：对照 `publicOrigin` 检查请求 Host 与 Origin，并确认 `--trusted-host` 包含公开 hostname。
- **Cloudflare 返回 502**：确认 DSH 在 `127.0.0.1:3080` 正常运行，且 tunnel route 使用相同 service URL。
- **管理页面返回 403**：通过 loopback 或 SSH local forward 访问，并在 browser 中使用 loopback URL；按设计，该页面无法通过公开 hostname 访问。
