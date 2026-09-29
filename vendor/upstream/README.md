# vendor/upstream — 上游脚本原件（仅供溯源）

这里放的是 [chugzb/VPN](https://github.com/chugzb/VPN) 的脚本**原样副本**，用于对照「我们改了什么」。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/chugzb/VPN |
| commit | `b93e540947e9e3598488ae485379f65b839fc7b9` ("fix: 优化线路波动") |
| 许可 | Apache License 2.0（见本目录 `LICENSE`） |
| 抓取时间 | 2026-09-29 |

## 文件对照

| 上游文件 | 本项目对应实现 | 说明 |
|---|---|---|
| `hy2.sh` | `server/hy2.sh` | Hysteria2，本项目默认协议 |
| `ss-rust.sh` | `server/ss-rust.sh` | Shadowsocks-Rust |
| `reality.sh` | `server/reality.sh` | VLESS + XTLS-Reality（上游是 773 行交互菜单） |
| `ws.sh` | — | VMess+WebSocket，需自行配合 CDN/TLS，未纳入自动化 |
| `tcp-wss.sh` | — | VLESS TCP + VMess WSS 双协议，未纳入自动化 |
| `https.sh` | — | HTTPS 伪装辅助 |
| `nft_forward.sh` | — | nftables 端口转发 |
| `tcp-window.sh` | `server/common.sh` 的 `enable_bbr()` | TCP 窗口/BBR 调优 |

## 上游与本项目的能力差异

上游脚本面向**人类手工执行**（会 `read -t 15` 倒计时问端口、输出是给人看的），
本项目把它们改造成**可无人值守、可幂等重跑、可被程序解析、可离线演练**的形态。

逐项对照见 [`../../docs/DESIGN.md`](../../docs/DESIGN.md) 的「上游改了什么」。

> ⚠️ 本目录的文件**不参与运行**，不要直接执行它们（是交互式脚本，会卡在等你输入端口）。
> 实际部署请用 `node bin/vpn.mjs setup ...`。

## 为什么保留

1. **可审计**：能逐行对比我们改了哪些地方
2. **可回溯**：上游更新后能看出差异
3. **许可合规**：Apache-2.0 要求保留原始许可与声明
