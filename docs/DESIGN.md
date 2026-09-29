# 设计说明

## 为什么不是"改几个 shell 脚本"

上游 [chugzb/VPN](https://github.com/chugzb/VPN) 是 8 个**面向人手工执行**的脚本：会 `read -t 15` 问端口、把结果按人类可读格式 echo 出来、假设你盯着屏幕复制配置。

要让「只给登录方式 → 全自动」成立，必须补上四件上游没有的东西：

1. **零交互**：一切靠环境变量驱动（`VPN_PORT` / `VPN_SERVER_IP` / …）
2. **幂等**：重复执行不能新建密码、不能改端口、不能打断在线连接
3. **机器可读**：状态要能被程序稳定解析，而不是 regex 猜中文输出
4. **可演练**：能在不碰宿主的前提下跑通全部逻辑（否则无法做 CI）

第 4 条尤其关键 —— 没有它，这个仓库就只能"发布出去靠用户踩坑验证"。

## 分层

```
bin/vpn.mjs            CLI：参数 → 命令分发 → 人话输出
  ├─ src/deploy.mjs    传输编排：上传 server/*.sh → 提权执行 → 回读 state.env
  │    └─ src/ssh.mjs  ssh2 封装 + ~/.ssh/config 解析 + sudo 提权 + SFTP
  ├─ src/protocols.mjs state → mihomo 配置 / 分享链接 / Clash 订阅（含手写 YAML 发射器）
  ├─ src/client.mjs    下载内核 / 生成配置 / 托管进程 / 系统代理 / 验证
  │    ├─ src/download.mjs  直连 → 镜像 → 借服务器中转
  │    └─ src/archive.mjs   无依赖 .gz / .zip 解包
  └─ src/util.mjs      参数解析 / 平台路径 / 终端输出

server/common.sh      服务端共享库：日志、依赖、端口、防火墙、BBR、状态
server/{hy2,ss-rust,reality}.sh   三种协议的非交互部署
server/uninstall.sh   卸载
```

**为什么编排层用 Node 而不是 shell**：要同时覆盖 Windows/macOS/Linux 本机、要支持密码 SSH（Windows 上没有 `sshpass`，`plink` 也不一定有）、要无依赖解压 zip、要写 Windows 注册表 —— 这些用 shell 做会变成三套互不相干的脚本。Node 是唯一一个三端都现成可用的运行时（DSH / 大多数开发机都有）。

**为什么服务端仍然是 bash**：目标机只保证有 bash 和 coreutils，不能假设有 Node。所以服务端只做"执行 + 回传状态"，不做决策。

## 关键契约：stdout / stderr 分离

> **stdout = 机器可读数据；stderr = 人类可读日志。**

这条约定不是审美问题，是**踩过坑**的：早期版本里 `resolve_port()` 内部调了 `info()` 打日志，而它又被 `PORT=$(resolve_port)` 命令替换捕获，结果端口值变成了 `"[ .. ] 复用已有端口 8378（幂等）\n8378"`，随后被 `set_kv` 的安全字符集校验拦下，报出「状态字段 VPN_PORT 含不安全字符」。

修复方式是把 `log/info/ok/warn/die` 全部重定向到 stderr，并在测试里加了一条断言：**stdout 里不允许出现日志标记**，防止回归。

## 幂等是怎么做到的

```
载入 /etc/vpn-skill/state.env（若存在）
  → 端口：命令行 > 历史状态 > 随机空闲
  → 密码/UUID：历史状态 > 新生成
  → 渲染配置到临时文件，与现有文件逐字节比对
      ├─ 相同 → 不落盘、不重启（不打断在线连接）
      └─ 不同 → 落盘 + 重启
```

Reality 的私钥**不进 `state.env`**（避免本机持有服务端私钥），重跑时从服务端的 xray 配置里回读。这样"重跑"和"换客户端配置"两件事互不干扰。

`--force` 的语义是"即使内容没变也重启服务"，**不是**"重置凭据" —— 后者会让已经发到手机上的配置瞬间失效。

## 下载策略：三级降级

本机在墙内时，直连 GitHub Release 基本不通。三级梯度：

```
1. github.com 直连
2. 内置镜像（ghproxy.net / gh-proxy.com / ghfast.top / …）或 VPN_MIRRORS
3. 把你的海外服务器当下载代理：远端 curl 下来 → SFTP 拉回本机
```

第 3 级是这个工具在墙内**唯一稳**的一条路，也是"客户端自动化"能成立的前提。

## 安全设计

- 本机代理只监听 `127.0.0.1`（`bind-address` + `allow-lan: false`），控制器带随机 secret
- 系统代理改前备份、`down` 时精确还原（Windows 只动 HKCU，不写 shell 配置文件）
- 服务端只写自己的目录，防火墙只开自己的端口，BBR 走独立 sysctl 文件
- `state.env` 走 0600；sudo 提权执行时自动把属主让回调用者
- 状态字段进 `state.env` 前过安全字符集（防注入），非法值直接 `die`

## 上游改了什么（逐项对照）

| 上游 | 本项目 | 原因 |
|---|---|---|
| `read -t 15` 问端口 | `VPN_PORT` 环境变量 | 无人值守 |
| `clear` + 彩色中文输出 | stdout 只出数据，日志走 stderr | 可被程序解析 |
| 每次执行都 `shuf` 新端口 + 新密码 | 复用 `state.env` | 重跑不作废已有客户端 |
| 不处理防火墙 | ufw/firewalld/iptables 自动放行 | 上游文档里写"请自行开放端口" |
| 无 BBR | TCP 协议自动开 BBR + 调缓冲 | 上游另有独立的 `tcp-window.sh` |
| 下载失败即退出 | 直连 → 镜像 → 服务器中转 | 弱网可用性 |
| 无卸载 | `server uninstall` | 运维闭环 |
| xray 配置直接上线 | 先 `xray run -test` 再重启 | 避免把服务改挂 |
| 无状态输出 | `state.env` + JSON 块 | 供 CLI / agent 消费 |
| `reality.sh` 773 行交互菜单 | 同样的能力，非交互 | 自动化 |
| 结果只打印给人看 | 本地生成 mihomo 配置 + 订阅 + 分享链接 | 客户端也自动化了 |

上游脚本原件保留在 `vendor/upstream/`。

## 验证证据（本仓库自带的测试是真的）

### 三层测试

| 层 | 命令 | 项数 | 覆盖 |
|---|---|---|---|
| 单元 | `npm test` | 14 | YAML 发射/转义、三种协议配置、分享链接、参数解析、env 注入转义、资产命名、镜像 URL |
| 服务端脚本 | `npm run test:bash` | 32 | dry-run 真跑 bash：状态输出、配置生成、**幂等**、`--force` 语义、命令行覆盖历史、非法值拒绝、卸载脚本、stdout 纯净性 |
| 本机端到端 | `npm run test:e2e` | 18 | **真实代理链**：本地起 `ssserver` 当服务端 → 下载 mihomo → 起进程 → 经代理拿 204 → 查出口 IP → 系统代理设置/还原往返 |
| SSH 集成 | `npm run test:ssh` | 9 | ssh2 连接（含 `~/.ssh/config`）、SFTP 上传、远端提权执行、状态回读、客户端装配 |

### `test:e2e` 到底证明了什么

它**不是** mock：在本机拉一个真正的 `ssserver`，把 `mihomo` 真正启动起来，然后：

- 经 `本地混合端口 → mihomo → ssserver → 公网` 请求 `https://www.gstatic.com/generate_204`，**断言返回 204**
- 用 mihomo 的控制器 API 触发一次节点延迟探测，**断言拿到真实延迟（实测 ~52ms）**
- 经代理查询出口 IP，**断言拿到真实公网 IP**
- 打开系统代理、读回注册表值、再关闭，**断言精确还原到操作前的值**

所以：**除了"服务端装在别人的机器上"这一点，客户端侧全部走真实代码路径**。

### 开发过程中被测试抓出来的真实缺陷

这些都是写下测试之后才暴露的，不是事后补写的：

| # | 缺陷 | 影响 | 修法 |
|---|---|---|---|
| 1 | `resolve_port()` 在命令替换里打日志 | 端口值被日志污染 → 状态写入被拒 | stdout/stderr 分离 + 回归断言 |
| 2 | hy2 配置头带生成时间戳 | 每次重跑都判定"配置已变更" → 每次都重启服务，幂等失效 | 去掉易变内容 |
| 3 | dry-run 仍往宿主 `/etc/systemd/system` 写单元文件 | "演练"污染宿主 | 新增 `apply_unit()`，dry-run 落到工作目录 |
| 4 | 无 BOM 的 UTF-8 PowerShell 脚本被 PS 5.1 按 ANSI 解析 | Windows 系统代理功能**整体不可用** | 写 BOM + 实测往返 |
| 5 | 出口 IP 只查 `ip-api.com` | 该服务在部分网络不可达 → 验证误报失败 | 5 个服务依次降级 |
| 6 | 非 root 登录 + 免密 sudo 时 `state.env` 属 root:600 | **部署成功但 CLI 报失败**，用户以为白干了 | 提权通道回读（`cat` → `sudo cat`）+ 执行时 `chown` 回 `SUDO_UID` |
| 7 | 显式 `--key` 失败就放弃 | `~/.ssh/config` 里明明有能用的 key 却连不上 | 多凭据依次尝试 |
| 8 | 未解析 `~/.ssh/config` | 用户得把已经配好的 User/Port/IdentityFile 再抄一遍 | 实现 config 解析（含 `Include`、glob 匹配、首个命中优先） |

第 4 和第 6 条如果只做"看着像对"的实现，会直接导致功能不可用 —— 它们都是被真实执行抓出来的。

### 复现测试

```bash
npm install
npm test && npm run test:bash && npm run test:e2e   # 不需要任何服务器
```

`test:e2e` 需要本机能访问 GitHub（下载 ssserver 与 mihomo），失败时它会明确说"本机无法访问 GitHub 及其镜像"。
