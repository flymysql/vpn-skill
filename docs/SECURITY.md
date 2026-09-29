# 安全说明

## 适用范围（先读这条）

vpn-skill 面向的是**你自己购买的海外服务器** + **你个人的设备**。

- ⚠️ **不要在公司的机器、公司内网环境部署或使用**。这很可能违反你的组织规定，并且可能被安全设备识别告警。
- 自建代理服务的**合法性由使用者自行负责**，请遵守你所在地的法律法规与服务商条款。
- 不要用它转发他人的流量、不要做对外提供服务的"公共机场"。

## 凭据处理

| 项 | 处理方式 |
|---|---|
| 服务端 Reality **私钥** | **只**落在服务器上的 `xray` 配置里；不进 `state.env`，不回传本机 |
| `state.env` | 权限 `600`；含协议/端口/密码/UUID/公钥/shortId/分享链接 |
| sudo 提权执行时 | 脚本会自动把 `state.env` 属主让回调用者（`SUDO_UID`），否则本机读不回来 |
| 上传的脚本 | 落在远端 `/tmp/vpn-skill-upload-<随机>/`，`env.sh` 权限 `600`（内含明文密码） |
| 本机 `meta.json` | 含 mihomo 控制器的随机 `secret`（可写 API 用），仅本机文件 |

**建议**

- 部署完可以清理远端临时目录：`rm -rf /tmp/vpn-skill-upload-*`（脚本不自动删，便于出问题复现）
- 分享链接**等价于密码**，别贴到公开地方
- 密码泄露了就 `server uninstall` 后重新 `setup`，或显式传一个新的 `--password`

## 本机侧

| 项 | 说明 |
|---|---|
| 混合端口只监听 `127.0.0.1` | 配置里写死 `bind-address: 127.0.0.1` + `allow-lan: false`，局域网内其他机器用不了你的代理 |
| 控制器只管本机 | `external-controller` 绑定 `127.0.0.1`，并带随机 `secret` |
| 系统代理改动可还原 | 改前备份到 `system-proxy.backup.json`，`down` 时精确还原 |
| Windows 只动 HKCU | 不碰 `HKLM`，不需要管理员（TUN 模式除外） |
| 不写 shell 配置文件 | Linux 非 GNOME 下只生成 `proxy.env`，不偷偷改你的 `.bashrc` |

## 服务端侧

| 项 | 说明 |
|---|---|
| 只用官方源 | hy2 用 `get.hy2.sh`、xray 用官方 `Xray-install` 脚本、ss 用官方 Release；全部有直连失败后的镜像兜底 |
| 配置先校验再上线 | reality 必须先通过 `xray run -test` 才重启服务 |
| 服务降权运行 | hysteria 以专用系统用户 `hysteria` 运行（官方安装脚本创建） |
| 不动无关配置 | 只写自己的目录（`/etc/hysteria`、`/etc/shadowsocks`、`/usr/local/etc/xray`、`/etc/vpn-skill`） |
| 防火墙只开自己的端口 | ufw/firewalld/iptables 上仅放行本次服务端口；`uninstall` 会回收 |
| BBR 走独立文件 | `/etc/sysctl.d/99-vpn-skill.conf`，不覆盖系统既有 sysctl 配置 |

## 自签证书与 `insecure`

Hysteria2 默认用自签证书，客户端配置里是 `skip-cert-verify: true`（分享链接里 `insecure=1`）。

- 这只影响**你与你自己服务器之间**的证书校验
- 风险面：理论上使你对「中间人替换服务器」的检测能力下降。因为你连的是自己指定的 IP，实际风险很低
- 想消除它：用 `--protocol reality`（伪装真站点、无需自签），或给服务器配域名并自行申请证书

## 数据传输

- SSH 连接使用你提供的密码或**本机私钥**，密钥文件不会被复制到任何地方
- 本工具**不上报**任何遥测；除下列目标外不发起外部连接：
  - 你的服务器（SSH）
  - GitHub / 镜像站（下载 mihomo 内核）
  - `www.gstatic.com`（验证 204）、`api.ipify.org` 等（查出口 IP，仅 `verify` 时）
- 所有外部下载都有**固定版本基线**（见 `package.json` 的 `sync.pinned`），不会静默拿到一个漂移的二进制

## 报告问题

发现安全问题时请**不要**开公开 issue，直接私信仓库作者。
