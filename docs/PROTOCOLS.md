# 协议详解

三种协议都由 `bin/vpn.mjs` 统一驱动，服务端脚本在 `server/` 下。

---

## Hysteria2（`--protocol hy2`，默认）

| 项 | 值 |
|---|---|
| 传输 | QUIC over TLS（**UDP**） |
| 服务端 | `apernet/hysteria`，官方安装脚本 `get.hy2.sh`，失败则直连 Release 兜底 |
| 二进制 | `/usr/local/bin/hysteria` |
| 服务 | `hysteria-server.service` |
| 配置 | `/etc/hysteria/config.yaml` |
| 证书 | 自签 EC（CN = SNI），客户端需跳过校验（`insecure`） |
| 端口 | 默认随机可用端口 |
| 实现要点 | `masquerade` 反代到真实站点应对主动探测；`ignoreClientBandwidth: true` 避免默认限速 |

**为什么是默认**：QUIC 在弱网/高丢包下表现明显更好，延迟最低；配置最简单，上游也把它列为新手首选。

**注意**

- 走 **UDP**：云安全组要放行 `端口/UDP`（这是最常见的连不上原因）
- 客户端必须支持 Hysteria2（mihomo 1.16+ / v2rayN 新版 / Shadowrocket / NekoBox）
- 自签证书 ⇒ 客户端跳过证书校验。如果想要真证书，改用 `reality`，或自行给服务器配域名 + ACME

**调参**（服务端 `/etc/hysteria/config.yaml`）

```yaml
quic:
  initStreamReceiveWindow: 26843545   # 默认已调大，弱网更稳
  maxStreamReceiveWindow: 26843545
  initConnReceiveWindow: 67108864
  maxConnReceiveWindow: 67108864
```

改完 `systemctl restart hysteria-server`。用 `--force` 重跑会把配置**重写回默认值**。

---

## Shadowsocks-Rust（`--protocol ss`）

| 项 | 值 |
|---|---|
| 传输 | TCP + UDP |
| 服务端 | `shadowsocks/shadowsocks-rust`，Release 直连 + 镜像兜底，版本默认 `v1.25.0`（可用 `VPN_SS_RELEASE` 覆盖） |
| 二进制 | `/usr/local/bin/ssserver` |
| 服务 | `shadowsocks.service` |
| 配置 | `/etc/shadowsocks/config.json`（600） |
| 加密 | 默认 `aes-128-gcm`，可选 `aes-256-gcm` / `chacha20-ietf-poly1305` / `xchacha20-ietf-poly1305` / `2022-blake3-*` |

**适用**：网络只放 TCP、或客户端较老；追求极致稳定与兼容性。

**注意**

- 同时监听 TCP 与 UDP ⇒ 安全组两个协议都要放行
- `2022-blake3-*` 系列需要 base64 长度合规的密钥，用默认随机 UUID 密码时**不要**选这类，会起不来

---

## VLESS + XTLS-Reality（`--protocol reality`）

| 项 | 值 |
|---|---|
| 传输 | TCP（伪装成对目标站点的真实 TLS 握手） |
| 服务端 | `XTLS/Xray-core`，官方 `Xray-install` 脚本，失败则 Release 直连兜底 |
| 二进制 | `/usr/local/bin/xray` |
| 服务 | `xray.service` |
| 配置 | `/usr/local/etc/xray/config.json` |
| 端口 | **默认优先 443**（与真实 HTTPS 同端口，伪装度最高）；被占用则随机 |
| 伪装目标 | `--reality-dest`，默认 `www.microsoft.com:443` |
| 客户端参数 | `flow=xtls-rprx-vision`、`fp=chrome`、`pbk`(公钥)、`sid`(shortId) |

**密钥策略（重要）**

- 私钥**只**落在服务端 `/usr/local/etc/xray/config.json`，**不写进 `state.env`**（本机侧拿不到私钥）
- 重跑时从服务端 xray 配置里**回读**私钥、从 `state.env` 复用公钥 ⇒ **重跑不会作废已经发到手机上的配置**
- 只有全新部署才生成密钥对（`xray x25519`）

**上线前校验**：配置写好后先跑 `xray run -test -config <conf>`，**校验通过才重启服务**。校验失败会中止并打印错误，避免把服务搞挂。

**选 dest 的原则**：选一个 TLS 1.3 + X25519 的大站（微软/苹果/Cloudflare 系），且不要和你的服务器 IP 有明显地域矛盾。

---

## 端口与防火墙

| 协议 | 需要放行 |
|---|---|
| hy2 | `端口/UDP` |
| ss | `端口/TCP` **和** `端口/UDP` |
| reality | `端口/TCP` |

服务端脚本会自动处理**本机防火墙**（ufw / firewalld / iptables），但**云安全组管不了**，必须你在云控制台放行。

不想让脚本动防火墙：`--no-firewall`。

## BBR

默认对 TCP 协议（ss / reality）开启 BBR + 调大 TCP 缓冲；hy2 走 QUIC 自带拥塞控制，不需要。关闭：`--no-bbr`。

写入内容在服务端 `/etc/sysctl.d/99-vpn-skill.conf`。
