---
name: vpn-skill
description: 在用户自己的海外服务器上自动部署 VPN 服务端（Hysteria2/Shadowsocks/VLESS-Reality），并在本机自动安装客户端、连接、验证出网。用户只需提供服务器登录方式（IP + 密码或私钥，可选 SSH 端口/用户；也支持 ~/.ssh/config 别名）。当用户说"帮我搭个 VPN""科学上网""我要翻墙""在服务器上装个代理""买了个海外服务器怎么用""连不上/网速慢的代理"时使用。
whenToUse: 用户提供了（或愿意提供）一台自己拥有的海外服务器登录方式，希望部署一个自用代理并让本机连上；或需要对已部署的 vpn-skill 做状态查询、验证、重连、卸载。
---

# vpn-skill — 自建 VPN 一键部署与连接

## 一句话

**用户只要给登录方式，其余全自动**：部署服务端 → 本机装客户端 → 连接 → 验证 → 汇报出口 IP。

```bash
node <repo>/bin/vpn.mjs setup --host <IP> --user root --password '<pw>'
```

## 触发后的执行协议

1. **先确认三件事**（缺哪问哪，一次问清，不要来回）：
   - 服务器地址（IP 或 `~/.ssh/config` 里的别名）
   - 登录用户 + 凭据（密码或私钥路径）；非 root 用户还需要 sudo 密码
   - 用哪个协议 —— **用户没说就默认 `hy2`**，不要追问
2. **先 `doctor` 再动手**：`node bin/vpn.mjs doctor`，确认 Node ≥ 18 与 `ssh2` 依赖就绪（首次需 `npm install`）。
3. **跑 `setup`**：
   ```bash
   node <repo>/bin/vpn.mjs setup --host <IP> --user <u> --password '<pw>' [--protocol hy2|ss|reality] [--json]
   ```
4. **按需下钻**（只在出问题时用，不要一上来就跑）：
   - 状态：`node bin/vpn.mjs status`
   - 验证：`node bin/vpn.mjs verify`
   - 服务端日志：`node bin/vpn.mjs server logs --host <IP> --user <u> --password '<pw>'`
5. **汇报**：协议、服务器、端口、**出口 IP**、如何断开（`down`）、分享链接在哪。

## 命令速查

| 需求 | 命令 |
|---|---|
| 全自动（默认首选） | `setup --host H [--user U] (--password P \| --key PATH)` |
| 只部署服务端 | `deploy --host H ...`（会打印分享链接给手机用） |
| 只装/更新客户端 | `client [--state <file>]` |
| 连接 / 断开 | `up` / `down` |
| 状态 / 验证 / 链接 | `status` / `verify` / `link` |
| 服务端运维 | `server status\|logs\|restart\|uninstall --host H ...` |
| 环境自检 | `doctor` |

常用选项：`--protocol hy2|ss|reality`、`--vpn-port N`、`--server-ip IP`（NAT/域名场景必须）、`--tui`→无、`--tun`、`--no-system-proxy`、`--json`、`--dry-run`、`--force`。

## 决策规则（按此判断，别自由发挥）

| 情况 | 选择 |
|---|---|
| 用户没指定协议 | `hy2`（最快、新手首选） |
| 用户说"怕被封""要隐蔽" | `reality` |
| 用户说"要稳""客户端兼容"或 UDP 被封 | `ss` |
| 服务器在 NAT 后面 / 给了域名 | 必须显式 `--server-ip` |
| 用户明确说"先别真的装" | 加 `--dry-run` |
| 验证失败且怀疑安全组 | 提示用户去云控制台放行端口（hy2 是 **UDP**，常被漏） |
| 本机下载内核失败 | 不用管，会自动走镜像和「借服务器中转」 |

## 硬性约束（必须遵守）

- **只在用户自己拥有的服务器上部署**。用户若提到公司机器、公司内网、生产环境，**停下来确认**再继续。
- **绝不把密码/私钥写进任何日志、文件或回复正文**。命令里出现的密码不要复述；汇报时只给用户看服务器地址、端口、出口 IP。
- **不要手工拼 ssh/scp/bazel 之类的命令**，一律走 `bin/vpn.mjs`，它已处理好 sudo 提权、状态回读、下载兜底。
- **不要手工改服务端的 `state.env` 或 `config.yaml`**；要改就重新 `setup`，幂等设计会保留凭据。
- `--force` 只重写配置并重启，**不会**重置凭据（这是刻意的：避免作废已发到手机上的配置）。
- 遇到平台依赖不可用（如本机无 Node）时，**明确告知缺什么、怎么补**，不要静默降级成"你自己手动装吧"。

## 关键路径（排障时看这些）

| 位置 | 内容 |
|---|---|
| 客户端目录 | Win: `%LOCALAPPDATA%\vpn-skill`；mac/Linux: `~/.vpn-skill` |
| `state.env` | 服务端状态（协议/端口/密码/UUID/公钥/shortId/分享链接） |
| `config.yaml` | mihomo 配置（本地混合端口、节点、规则） |
| `subscription.yaml` | 给图形客户端导入的订阅 |
| `link.txt` | 手机端分享链接 |
| `mihomo.log` | 客户端内核日志 |
| 服务端 `/etc/vpn-skill/state.env` | 服务端状态原件（root，600） |

## 验证标准

`setup` 末尾会自动验证，判据是 **HTTPS 隧道拿到 204** + **出口 IP 与直连 IP 不同**。
如果 `verify` 只拿到 204 但出口 IP 与直连相同，说明流量可能没走代理，要按 `docs/TROUBLESHOOTING.md` 排查。

## 仓库内自测（无海外服务器也能验证）

```bash
npm install
npm test            # 单元 14 项
npm run test:bash   # 服务端脚本 dry-run 32 项
npm run test:e2e    # 本机真实端到端 18 项（本地起 ssserver 当服务端，真过代理出网）
```

面向人的完整文档：[`README.md`](README.md)、[`docs/USAGE.md`](docs/USAGE.md)、[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。
