#!/usr/bin/env bash
# vpn-skill :: server/ss-rust.sh — Shadowsocks-Rust 非交互部署
#
# 上游对应: chugzb/VPN/ss-rust.sh（交互式读端口、依赖 jq + GitHub API 查最新版）
# 本脚本差异: 零交互 / 固定版本兜底（不依赖 GitHub API 限流额度）/ 幂等 / 状态回传
set -euo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$_HERE/common.sh"
trap 'finish_common' EXIT

SS_RELEASE="${VPN_SS_RELEASE:-v1.25.0}"
CONF_DIR="${VPN_CONF_DIR:-/etc/shadowsocks}"
CONF="$CONF_DIR/config.json"
BIN=/usr/local/bin/ssserver
UNIT=shadowsocks.service

main() {
  init_common
  VPN_PROTOCOL="ss"
  need_root

  log ""
  log "=============================================="
  log "  vpn-skill · Shadowsocks-Rust 部署"
  log "=============================================="
  info "系统: $(detect_os) / 架构: $(detect_arch)"

  VPN_SS_METHOD="${USER_VPN_SS_METHOD:-${VPN_SS_METHOD:-aes-128-gcm}}"
  case "$VPN_SS_METHOD" in
    aes-128-gcm|aes-256-gcm|chacha20-ietf-poly1305|xchacha20-ietf-poly1305|2022-blake3-aes-128-gcm|2022-blake3-aes-256-gcm) ;;
    *) die "不支持的加密方式: $VPN_SS_METHOD" ;;
  esac

  VPN_PORT="$(resolve_port tcp "$UNIT")"
  VPN_PASSWORD="$(resolve_secret "${VPN_PASSWORD:-}")"
  VPN_TAG="${VPN_TAG:-vpn-skill-ss}"
  VPN_HOST="$(get_public_ip)"
  [ "$VPN_HOST" = "unknown" ] && warn "未能确定服务器地址，客户端将无法连接（请用 VPN_SERVER_IP 指定）"

  install_pkgs curl wget ca-certificates tar xz-utils
  install_ssserver
  render_config
  svc_apply_if_needed "$UNIT" "$BIN"
  open_firewall "$VPN_PORT" tcp
  open_firewall "$VPN_PORT" udp
  enable_bbr

  local userinfo userinfo_b64
  userinfo="${VPN_SS_METHOD}:${VPN_PASSWORD}"
  userinfo_b64="$(printf '%s' "$userinfo" | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  VPN_LINK="ss://${userinfo_b64}@${VPN_HOST}:${VPN_PORT}#${VPN_TAG}"

  set_kv VPN_SKILL_VERSION "$VPN_SKILL_VERSION"
  set_kv VPN_PROTOCOL      "ss"
  set_kv VPN_HOST          "$VPN_HOST"
  set_kv VPN_PORT          "$VPN_PORT"
  set_kv VPN_PASSWORD      "$VPN_PASSWORD"
  set_kv VPN_SS_METHOD     "$VPN_SS_METHOD"
  set_kv VPN_TRANSPORT     "tcp+udp"
  set_kv VPN_SERVICE       "$UNIT"
  set_kv VPN_TAG           "$VPN_TAG"
  set_kv VPN_LINK          "$VPN_LINK"
  set_kv VPN_INSTALLED_AT  "$(date +%s)"
  write_state

  log ""
  ok "Shadowsocks-Rust 部署完成"
  log "  服务器   : ${C_YELLOW}${VPN_HOST}${C_RST}"
  log "  端口     : ${C_YELLOW}${VPN_PORT} (TCP+UDP)${C_RST}"
  log "  密码     : ${C_YELLOW}${VPN_PASSWORD}${C_RST}"
  log "  加密方式 : ${C_YELLOW}${VPN_SS_METHOD}${C_RST}"
  log "  链接     : ${C_GREEN}${VPN_LINK}${C_RST}"
  log ""
  if [ "${VPN_DRY_RUN:-0}" != "1" ]; then
    log "  管理: systemctl {status|restart|stop} ${UNIT}"
    log "  提醒: 若为云主机，请确认安全组已放行 ${VPN_PORT}/TCP 与 ${VPN_PORT}/UDP"
  fi
  emit_state
}

install_ssserver() {
  mkdir -p "$WORKDIR" "$CONF_DIR"
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    info "dry-run: 跳过 shadowsocks-rust 安装"
    return 0
  fi
  if [ -x "$BIN" ]; then
    ok "已存在 ssserver: $("$BIN" --version 2>/dev/null | head -1 || echo unknown)"
    return 0
  fi

  local arch asset url tarball
  arch="$(detect_arch)"
  case "$arch" in
    amd64) asset=x86_64 ;; arm64) asset=aarch64 ;; armv7) asset=arm ;; 386) asset=i686 ;;
    *) die "shadowsocks-rust 不支持架构 $arch" ;;
  esac

  tarball="shadowsocks-${SS_RELEASE}.${asset}-unknown-linux-gnu.tar.xz"
  url="https://github.com/shadowsocks/shadowsocks-rust/releases/download/${SS_RELEASE}/${tarball}"
  info "下载 shadowsocks-rust ${SS_RELEASE} (${asset})"
  download_first "$WORKDIR/$tarball" "$url" "https://ghproxy.net/${url}" "https://gh-proxy.com/${url}" \
    || die "shadowsocks-rust 下载失败，请检查服务器外网出口"

  tar -xJf "$WORKDIR/$tarball" -C "$WORKDIR" ssserver 2>/dev/null \
    || tar -xf "$WORKDIR/$tarball" -C "$WORKDIR" ssserver 2>/dev/null \
    || die "解压失败（缺少 xz 支持？）"
  [ -f "$WORKDIR/ssserver" ] || die "压缩包内未找到 ssserver"
  install -m 0755 "$WORKDIR/ssserver" "$BIN"
  rm -f "$WORKDIR/$tarball" "$WORKDIR/ssserver"
  ok "ssserver 已安装: $("$BIN" --version 2>/dev/null | head -1 || echo unknown)"
}

render_config() {
  mkdir -p "$CONF_DIR"
  local tmp="$WORKDIR/config.json.$$"
  cat >"$tmp" <<EOF
{
  "server": "::",
  "server_port": ${VPN_PORT},
  "password": "${VPN_PASSWORD}",
  "method": "${VPN_SS_METHOD}",
  "timeout": 600,
  "mode": "tcp_and_udp",
  "fast_open": false
}
EOF
  apply_config "$tmp" "$CONF" 0600

  local unit_tmp="$WORKDIR/unit.$$"
  cat >"$unit_tmp" <<EOF
[Unit]
Description=Shadowsocks-Rust Server (vpn-skill)
Documentation=https://github.com/flymysql/vpn-skill
After=network.target

[Service]
Type=simple
ExecStart=${BIN} -c ${CONF}
LimitNOFILE=65535
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=multi-user.target
EOF
  apply_unit "$unit_tmp" "$UNIT"
}

main "$@"
