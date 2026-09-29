# 使用手册

## 1. 最短路径

```bash
node bin/vpn.mjs setup --host 1.2.3.4 --user root --password 'pwd'
```

它一次做完：部署服务端 → 装本机客户端 → 起代理 → 设系统代理 → 验证出网 → 打印分享链接。

结束时的输出长这样：

```
[ ok ] 部署完成，用时 42s
  协议   : hy2
  服务器 : 203.0.113.10:34567
  密码   : xxxx-xxxx-...   SNI: bing.com
  分享链接: hysteria2://...@203.0.113.10:34567/?insecure=1&sni=bing.com#vpn-skill-hy2
[ ok ] mihomo 已启动 (pid 12345, 混合端口 7890)
[ ok ] 系统代理已设置为 127.0.0.1:7890
[ ok ] HTTPS 隧道 (gstatic/generate_204): HTTP 204 · 167ms
[ ok ] 出口 IP: 203.0.113.10 (Japan)  ·  直连 IP: 12.34.56.78
[ ok ] 全部完成 ✅
```

## 2. 登录方式怎么写

### 密码

```bash
--host 1.2.3.4 --user root --password 'pwd'
```

### 私钥

```bash
--host 1.2.3.4 --user ubuntu --key ~/.ssh/id_ed25519
```

### 只给 host，其余交给 `~/.ssh/config`

只要 `~/.ssh/config` 里有这个主机，`User` / `Port` / `IdentityFile` 都会自动读取：

```
Host myserver
    HostName 1.2.3.4
    User ubuntu
    Port 22022
    IdentityFile ~/.ssh/id_ed25519
```

```bash
node bin/vpn.mjs setup --host myserver      # 就够了
```

> `Include` 也被支持。显式传的 `--key` 失败时，会自动继续尝试 `~/.ssh/config` 和 `~/.ssh/` 下的默认私钥。

### 非 root 用户（需要 sudo）

```bash
node bin/vpn.mjs setup --host 1.2.3.4 --user ubuntu --key ~/.ssh/key --sudo-password 'sudo密码'
```

免密 sudo 时不需要 `--sudo-password`。

## 3. 三种协议怎么选

```bash
--protocol hy2       # 默认。最快、延迟最低、抗封锁好（UDP/QUIC）
--protocol ss        # 最稳、兼容性最好（TCP，客户端几乎都支持）
--protocol reality   # 隐蔽性最强，握手伪装成真实 TLS（默认走 443）
```

换协议 = 重新 setup，端口和凭据会复用：

```bash
node bin/vpn.mjs setup --host 1.2.3.4 --password 'pwd' --protocol reality
```

> 换协议后，**旧协议的分享链接会失效**，要重新 `link` 取新的。

## 4. 服务器在 NAT 后面 / 用域名

```bash
node bin/vpn.mjs setup --host 1.2.3.4 --password 'pwd' --server-ip vpn.example.com
```

`--server-ip` 决定写进客户端配置和分享链接里的地址。不指定时脚本会自动探测公网 IP；如果服务器在 NAT 后面或要走域名，**必须显式指定**，否则客户端会连到一个不可达的地址。

## 5. 常用运维

```bash
node bin/vpn.mjs status      # 本机：进程/端口/系统代理/内核版本
node bin/vpn.mjs verify      # 验证出网 + 出口 IP（失败退出码 2）
node bin/vpn.mjs link        # 再拿一次分享链接（给新手机用）
node bin/vpn.mjs up          # 重连（幂等，已在运行则复用）
node bin/vpn.mjs down        # 断开：还原系统代理 + 停进程

node bin/vpn.mjs server status   --host 1.2.3.4 --password 'pwd'
node bin/vpn.mjs server logs     --host 1.2.3.4 --password 'pwd' [--unit hysteria-server] [--lines 100]
node bin/vpn.mjs server restart  --host 1.2.3.4 --password 'pwd'
node bin/vpn.mjs server uninstall --host 1.2.3.4 --password 'pwd'
```

## 6. TUN 全局代理（可选）

默认走「本地混合端口 + 系统代理」，覆盖浏览器和大多数应用到代理设置。有些应用（部分游戏、终端工具、不读系统代理的程序）不吃这套，需要 TUN：

```bash
node bin/vpn.mjs up --tun       # Windows 需要管理员权限；会自动获取 wintun.dll
```

- Windows：需要**以管理员身份**运行；`wintun.dll` 会自动下载到客户端目录
- macOS：需要 `sudo`（创建 utun）
- TUN 会接管全部流量（含 DNS），排查 DNS 问题时先用非 TUN 模式验证

## 7. 让 agent 跑（机器可读输出）

```bash
node bin/vpn.mjs setup --host 1.2.3.4 --password 'pwd' --json
node bin/vpn.mjs verify --json
node bin/vpn.mjs status --json
```

退出码：`0` 成功；`1` 参数/依赖/连接错误；`2` 验证未通过。

## 8. 环境变量

| 变量 | 作用 |
|---|---|
| `VPN_MIRRORS` | 额外/优先的下载镜像前缀，逗号分隔，如 `https://ghproxy.net/` |
| `NO_COLOR` | 关闭彩色输出 |
| `VPNSKILL_BASH` | 测试用：指定 bash 路径 |

服务端脚本还认一批 `VPN_*` 变量（`VPN_PORT` / `VPN_SERVER_IP` / `VPN_PASSWORD` / `VPN_SNI` / `VPN_STATE_DIR` / `VPN_FORCE` / `VPN_DRY_RUN` 等），一般不用手工传 —— CLI 会替你注入到远端。

## 9. 目录与文件

| 路径 | 内容 |
|---|---|
| `%LOCALAPPDATA%\vpn-skill`（Win）/ `~/.vpn-skill` | 客户端目录 |
| `config.yaml` | mihomo 配置 |
| `subscription.yaml` | 图形客户端订阅 |
| `link.txt` | 分享链接 |
| `state.env` | 服务端状态副本（`deploy` 时落盘） |
| `meta.json` | 本地运行态（端口、pid、secret） |
| `mihomo.log` | 内核日志 |
| `system-proxy.backup.json` | 设置系统代理前的原始值（用于精确还原） |
| 服务端 `/etc/vpn-skill/state.env` | 状态原件（root:600） |
| 服务端 `/etc/hysteria` `/etc/shadowsocks` `/usr/local/etc/xray` | 各协议配置 |
