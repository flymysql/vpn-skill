# 排障手册

## 按现象查

### 1. 验证失败：`HTTPS 隧道 ... 失败`

链路上有三个环节，按顺序排：

```bash
node bin/vpn.mjs status                                   # ① 本机进程起了吗
node bin/vpn.mjs server status --host H --password 'pwd'   # ② 服务端服务活着吗
```

| 检查 | 命令 | 期望 |
|---|---|---|
| 本机监听 | `node bin/vpn.mjs status` | `进程: 运行中`、混合端口有值 |
| 端口连通 | `Test-NetConnection 127.0.0.1 -Port 7890`（Win）<br>`nc -vz 127.0.0.1 7890` | 通 |
| 服务端 | `node bin/vpn.mjs server status ...` | 对应 unit `active` |
| 服务端日志 | `node bin/vpn.mjs server logs ...` | 无报错 |
| 安全组 | 云控制台 | 放行 `端口/协议` |

**最高频原因（按经验排序）**

1. **云安全组没放行**。hy2 是 **UDP**，最容易漏；ss 要 TCP+UDP 都放行
2. 服务器在 NAT 后面，客户端配到的是内网地址 ⇒ 用 `--server-ip <公网IP或域名>` 重新 setup
3. 服务端没起来（`xray -test` 没过 / 端口被占用 / 依赖没装上）⇒ 看 `server logs`
4. 服务器出口本身被限制（机房封 UDP / 出海线路差）⇒ 换 `--protocol ss` 试

### 2. 拿到 204 但「出口 IP 与直连相同」

说明流量**没走代理**（或代理没生效）。

- 浏览器装了别的代理插件，覆盖了系统代理 ⇒ 先关插件
- 应用不读系统代理（部分游戏/终端）⇒ `node bin/vpn.mjs up --tun`
- 用了 PAC 脚本 ⇒ 脚本会临时移除 `AutoConfigURL`，断开时再还原

### 3. 系统代理设置失败 / 不生效

```bash
node bin/vpn.mjs status     # 看"系统代理"一行
```

- Windows：只改 `HKCU`，不需要管理员；改完会调 `InternetSetOption` 通知系统。若浏览器仍不生效，**完全重启浏览器**（有些浏览器启动时缓存代理）
- macOS：会遍历所有网络服务设置；若某服务名含中文/特殊字符可能失败，用 `networksetup -listallnetworkservices` 手工看一眼
- Linux 非 GNOME 桌面：没有 `gsettings`，脚本会生成 `~/.vpn-skill/proxy.env`，`source` 它即可（只影响当前 shell）

`down` 会**精确还原**设置前的值（备份在 `system-proxy.backup.json`）。

### 4. 本机下载 mihomo 卡住 / 失败

下载顺序是：**直连 GitHub → 内置镜像 → 借你的服务器中转再 SFTP 拉回**。

- 前两步慢/失败是常态（墙内），第三步会自动接管，**不要中断**
- 想自定义镜像：`export VPN_MIRRORS=https://你的镜像/`
- 想手工放内核：把 `mihomo(.exe)` 放到客户端目录（Win 是 `%LOCALAPPDATA%\vpn-skill`），再执行 `up`

### 5. 部署成功但 CLI 报「未能取回状态文件」

这是**权限**问题，不是部署失败：非 root 登录 + sudo 提权时，`state.env` 一开始属于 root（600）。

- 已内置处理：先 `cat`，失败则自动 `sudo cat`
- 若两者都失败：`node bin/vpn.mjs server status --host H --password 'pwd'` 看状态文件内容，或直接 SSH 上去 `sudo cat /etc/vpn-skill/state.env`
- 以 sudo 执行时，脚本会主动把 `state.env` 属主让回调用者（`SUDO_UID`）

### 6. 重跑会不会把我的配置搞坏？

不会。设计上：

- 端口 / 密码 / UUID / Reality 密钥对 **全部复用**
- 配置内容逐字节比对，**没变就不重启服务**（不打断在线连接）
- `--force` 只"强制重写并重启"，**依然不重置凭据**

想真正换一套凭据：显式传 `--password` / 先 `server uninstall` 再 setup。

### 7. 怎么彻底卸载

```bash
node bin/vpn.mjs down                        # 本机：还原系统代理、停进程
node bin/vpn.mjs server uninstall --host H --password 'pwd'   # 服务端：停服务、删配置、回收端口放行
```

服务端 uninstall 会**保留**二进制（`/usr/local/bin/{hysteria,ssserver,xray}`），要连二进制一起删：

```bash
ssh root@H 'rm -f /usr/local/bin/{hysteria,ssserver,xray}'
```

本机客户端目录删掉即可：`rm -rf ~/.vpn-skill`（Win: `%LOCALAPPDATA%\vpn-skill`）。

---

## 拿证据（定位用的三条命令）

```bash
node bin/vpn-skill status --json                     # 本机全量状态
node bin/vpn.mjs verify --json                       # 验证明细（含直连对照）
node bin/vpn.mjs server logs --host H --password 'pwd' --lines 200
```

服务端手工排查：

```bash
systemctl status hysteria-server      # 或 shadowsocks / xray
journalctl -u hysteria-server -n 100 --no-pager
ss -lntup | grep <端口>
cat /etc/vpn-skill/state.env
```

---

## 已知边界

| 场景 | 行为 |
|---|---|
| 服务端无 systemd（容器/OpenVZ） | 脚本会跳过服务托管并提示；进程需要你自己 nohup 拉起 |
| 服务端只有 IPv6 | 可用，但 `--server-ip` 要显式给出 IPv6（分享链接会带 `[]`） |
| 服务端架构 armv7/386 | hy2 与 ss 支持；reality 需要 xray 对应资产，均已覆盖常见架构 |
| 本机 Node < 18 | `doctor` 会报错；请升级 Node（用到内置 `fetch`） |
| 没有任何可用私钥且没给密码 | 连接前就会明确报错，不会静默失败 |
