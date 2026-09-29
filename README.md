# vpn-skill

> **你只需要给我海外服务器的登录方式，剩下的我来：**
> 部署服务端 → 本机装客户端 → 连上 → 验证出网。

一条命令把「自建 VPN」这件事从「看教程、复制脚本、手工填端口、装客户端、配代理、排查连不上」压成一次调用：

```bash
npx github:flymysql/vpn-skill setup --host 1.2.3.4 --user root --password '你的密码'
```

跑完之后：本机已经挂上了代理（默认 `127.0.0.1:7890`，HTTP/SOCKS5 同端口），`https://www.gstatic.com/generate_204` 返回 204，并打印出可直接导入手机客户端的分享链接。

---

## 目录

- [30 秒上手](#30-秒上手)
- [它到底做了什么](#它到底做了什么)
- [支持哪些协议](#支持哪些协议)
- [环境要求](#环境要求)
- [完整命令](#完整命令)
- [把配置导入手机 / 图形客户端](#把配置导入手机--图形客户端)
- [常见问题](#常见问题)
- [没有海外服务器怎么自测](#没有海外服务器怎么自测)
- [安全边界](#安全边界)
- [来源与致谢](#来源与致谢)

---

## 30 秒上手

### 方式一：作为 agent skill 使用（推荐）

把 `SKILL.md` 装进支持 skill 的 agent，然后直接说：

> 我的服务器是 `1.2.3.4`，root / 密码 `xxxx`，帮我搭个 VPN 并连上。

agent 会执行 `vpn-skill setup` 并汇报出口 IP。

```bash
# DSH 用户：软链到 skills 目录即可
git clone https://github.com/flymysql/vpn-skill.git ~/vpn-skill
ln -s ~/vpn-skill ~/.dsh/skills/vpn-skill
```

### 方式二：命令行直接用

```bash
git clone https://github.com/flymysql/vpn-skill.git && cd vpn-skill
npm install

node bin/vpn.mjs setup --host 1.2.3.4 --user root --password '你的密码'

# 之后
node bin/vpn.mjs status     # 看状态
node bin/vpn.mjs verify     # 验证出网
node bin/vpn.mjs down       # 断开（还原系统代理、停进程）
node bin/vpn.mjs link       # 再拿一次分享链接
```

### 已经跑过一次，只想重连

```bash
node bin/vpn.mjs up
```

---

## 它到底做了什么

```
┌─ 本机 ───────────────────────────────────────────────┐      ┌─ 你的海外服务器 ─┐
│ 1. 解析登录方式                                        │      │                  │
│    ~/.ssh/config 的 User/Port/IdentityFile 优先        │      │                  │
│ 2. SSH 连上，探测 OS/架构/是否 root/systemd            │─────▶│                  │
│ 3. 上传 server/*.sh（零交互 + 幂等 + dry-run）         │      │ 4. 装协议后端起服务│
│ 5. 读回 state.env（必要时 sudo cat）                   │◀─────│    开防火墙/BBR   │
│ 6. 下载 mihomo 内核（直连→镜像→借服务器中转）          │      │    写 state.env   │
│ 7. 生成 config.yaml / 分享链接 / Clash 订阅            │      │                  │
│ 8. 启动 mihomo，设置系统代理                           │      │                  │
│ 9. 验证：204 + 出口 IP + 直连对照                      │      │                  │
└──────────────────────────────────────────────────────┘      └──────────────────┘
```

几个刻意的设计选择：

| 决策 | 原因 |
|---|---|
| 单一内核 **mihomo** 通吃三种协议 | 装一个二进制、一份配置文件，不用按协议换客户端 |
| 走 **本地混合端口 + 系统代理**，TUN 作为可选 | TUN 需要管理员权限 + wintun 驱动，默认路径必须无痛 |
| 服务端脚本 **零交互 + 幂等** | 重复执行不新建密码、不改端口、不打断在线连接 |
| 凭据只生成一次并写入 `state.env` | 重跑不会作废已经发到手机上的配置 |
| 下载失败时**借服务器中转**再拉回本地 | 墙内直连 GitHub 不通时，这是唯一稳的路 |

---

## 支持哪些协议

| `--protocol` | 协议 | 默认端口 | 适合 |
|---|---|---|---|
| `hy2`（默认） | Hysteria2 (QUIC/TLS) | 随机 | 测速最快、游戏延迟最低、抗封锁好。**新手首选** |
| `ss` | Shadowsocks-Rust | 随机 | TCP 最稳、客户端兼容性最好、UDP 环境友好 |
| `reality` | VLESS + XTLS-Reality | **443** | 隐蔽性最强，握手伪装成真实 TLS 站点，抗主动探测 |

三种协议都由同一份 `state.env` 驱动，可以随时换协议重部署（旧协议的分享链接会失效）。

细节见 [`docs/PROTOCOLS.md`](docs/PROTOCOLS.md)。

---

## 环境要求

**本机（跑 CLI 的那台）**

- Node.js ≥ 18.17（用到内置 `fetch`）
- Windows / macOS / Linux
- 能 SSH 到你的服务器（密码或私钥都行）

**服务端**

- Linux，有 `systemd`（Ubuntu 18+/Debian 9+/CentOS 7+/TencentOS/ AlmaLinux/Rocky…）
- 1 核 1G 起
- 能访问 GitHub（官方安装脚本 / Release 下载）；不通时脚本会自动切镜像源
- ⚠️ 云主机记得在**安全组**里放行对应端口的 TCP/UDP —— 本地防火墙脚本会帮你开，安全组只能你自己开

---

## 完整命令

```
vpn-skill setup   --host <IP> [登录参数] [选项]   一条命令搞定全部
vpn-skill deploy  --host <IP> [登录参数] [选项]   只部署服务端
vpn-skill client  [--state <file>] [选项]         只装/更新本机客户端
vpn-skill up | down | status | verify | link     连接 / 断开 / 状态 / 验证 / 链接
vpn-skill server  <status|logs|restart|uninstall> --host <IP> [登录参数]
vpn-skill doctor                                  本机环境自检
```

**登录参数**

| 参数 | 说明 |
|---|---|
| `--host <ip>` | 服务器地址（必填）。也支持 `~/.ssh/config` 里的别名 |
| `--port <n>` | SSH 端口，默认 22（`~/.ssh/config` 里有则用配置里的） |
| `--user <name>` | SSH 用户，默认 `root` |
| `--password <pw>` | SSH 密码 |
| `--key <path>` | SSH 私钥文件 |
| `--sudo-password <pw>` | 非 root 登录时的 sudo 密码 |

> **不需要重复填参数**：`User` / `Port` / `IdentityFile` 会从 `~/.ssh/config` 读取（`Include` 也支持）。
> 平时 `ssh myhost` 能通的，这里 `--host myhost` 就能通。

**部署选项**

| 参数 | 说明 |
|---|---|
| `--protocol <p>` | `hy2`(默认) / `ss` / `reality` |
| `--vpn-port <n>` | 服务端口，默认随机；`reality` 默认优先 443 |
| `--server-ip <ip>` | 服务器对外 IP/域名。**NAT / 有 CDN 时必须指定** |
| `--sni <domain>` | hy2 伪装 SNI（默认 `bing.com`）/ reality 伪装域名 |
| `--reality-dest <h:p>` | reality 回落目标，默认 `www.microsoft.com:443` |
| `--method <m>` | SS 加密方式，默认 `aes-128-gcm` |
| `--tag <name>` | 节点显示名 |
| `--no-bbr` / `--no-firewall` | 跳过 BBR 优化 / 防火墙自动放行 |
| `--force` | 强制重写配置并重启服务（**凭据不变**，不会作废已下发的客户端） |
| `--dry-run` | 远端只演练配置生成，不装二进制、不启服务 |

**客户端选项**

| 参数 | 说明 |
|---|---|
| `--dir <path>` | 客户端目录，默认 `%LOCALAPPDATA%\vpn-skill`(Win) / `~/.vpn-skill` |
| `--proxy-port <n>` | 本地混合端口，默认 `7890` |
| `--tun` | 启用 TUN 全局代理（Windows 需管理员 + 自动取 wintun） |
| `--no-system-proxy` | 不自动设置系统代理 |
| `--no-verify` | 跳过连通性验证 |
| `--json` | 输出机器可读 JSON（给 agent / 脚本用） |

---

## 把配置导入手机 / 图形客户端

```bash
node bin/vpn.mjs link
```

- **分享链接**：直接粘进 Shadowrocket / v2rayN / NekoBox / Clash Verge / Stash
- **订阅文件**：客户端目录下的 `subscription.yaml`，可导入 Clash Verge / ClashX / Stash
- **可选**：`config.yaml` 本身就是一份完整的 mihomo 配置，可被任何 Clash.Meta 内核客户端直接用

---

## 常见问题

| 现象 | 先看这里 |
|---|---|
| 验证失败 / 204 拿不到 | 云**安全组**是否放了端口（hy2 是 **UDP**，最容易忘）；`vpn-skill server logs` 看服务端日志 |
| 系统代理设了但浏览器不走 | 浏览器用了别的代理插件；或需要重开浏览器（脚本已调 `InternetSetOption` 通知系统） |
| 本机下载 mihomo 卡住 | 会自动走镜像和「服务器中转」；也可 `export VPN_MIRRORS=https://你的镜像/` 自备源 |
| 部署成功但 CLI 报读不到状态 | 已自动用 `sudo cat` 读取；若仍失败见 `docs/TROUBLESHOOTING.md` |
| 想换协议 | 直接 `--protocol reality` 重新 setup，端口/凭据会自动复用 |

完整排查手册：[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)

---

## 没有海外服务器怎么自测

本仓库自带三层可离线跑的验证：

```bash
npm test              # 22 项：配置生成 / 分享链接 / 参数解析 / 转义 + 字节不变量自检
npm run test:bash     # 32 项服务端脚本自测：dry-run 真跑 bash，验幂等/覆盖/注入防护
npm run test:e2e      # 18 项本机端到端：本机起 ssserver 当"服务端"，
                      # 下载 mihomo → 起进程 → 真实过代理出网 → 系统代理开关往返
```

`test:e2e` 是**真的**在跑代理链：它会拉一个 `ssserver` 在本地当服务端，然后检查 `https://www.gstatic.com/generate_204` 是否返回 204、出口 IP 是多少、系统代理能否设置并**精确还原**。除「服务端装在别人的机器上」这一点之外，全部走真实代码路径。

如果你有 Linux 机器想验证 SSH 传输层（不装任何服务，纯 dry-run，只写 `/tmp`）：

```bash
VPNSKILL_TEST_SSH_HOST=1.2.3.4 VPNSKILL_TEST_SSH_PORT=22 npm run test:ssh
```

---

## 安全边界

- **只读优先**：所有查询类操作只读；写操作仅限你自己指定的那台服务器
- **凭据只存服务端**：Reality 私钥只落在服务器上的 xray 配置里，`state.env` 里没有它
- **状态文件 600**：`state.env` 仅属主可读；以 sudo 提权执行时会自动把属主让回调用者
- **不碰公司网络**：本工具用于**你自己的**海外服务器与**个人**设备。请勿在公司机器 / 内网环境部署或使用，那可能违反你的组织规定
- **请遵守当地法律**：自建代理服务的合规性由使用者自行负责

详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

---

## 来源与致谢

本项目把 [chugzb/VPN](https://github.com/chugzb/VPN)（commit `b93e540`）的 8 个交互式 bash 脚本工程化成了可发布、可测试、可被 agent 调用的形态。上游脚本原件完整保留在 [`vendor/upstream/`](vendor/upstream/) 以便溯源对照。

主要改造点：

1. **零交互**：去掉所有 `read -t 15` 倒计时提示，改为环境变量驱动
2. **幂等**：重跑复用端口/密码/UUID/密钥，配置未变则不重启服务
3. **机器可读**：`state.env` + stdout 上的 JSON 块，CLI 不再靠正则猜输出
4. **可演练**：`VPN_DRY_RUN=1` 全程零副作用（不下载、不启服务、不动防火墙、不写 `/etc`）
5. **补齐上游缺失的**：防火墙自动放行、BBR、下载镜像兜底、xray 配置先 `-test` 再上线、一键卸载
6. **客户端自动化**：本机下载内核、生成配置、托管进程、设/还原系统代理、验证出网

许可：**Apache-2.0**（见 [LICENSE](LICENSE)）—— 与上游保持一致，署名见 [NOTICE](NOTICE)。
