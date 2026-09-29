#!/usr/bin/env bash
# vpn-skill :: server/hy2.sh — Hysteria2 非交互部署（默认协议）
#
# 上游对应: chugzb/VPN/hy2.sh（交互式、15 秒倒计时读端口）
# 本脚本差异: 零交互 / 幂等 / 状态回传 / 防火墙自动放行 / 官方装失败自动直连下载兜底
#
# 用法（由本机 CLI 自动完成，手工执行示例）:
#   VPN_PORT=23456 VPN_SERVER_IP=1.2.3.4 bash hy2.sh
# 离线演练（不下载、不启服务，仅验证配置生成与状态输出）:
#   VPN_DRY_RUN=1 VPN_STATE_DIR=/tmp/vpnskill bash hy2.sh
set -euo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$_HERE/common.sh"
trap 'finish_common' EXIT

HY2_RELEASE="${VPN_HY2_RELEASE:-app/v2.12.3}"   # 上游直连下载兜底用的固定版本
CONF_DIR="${VPN_CONF_DIR:-/etc/hysteria}"
CONF="$CONF_DIR/config.yaml"
BIN=/usr/local/bin/hysteria
UNIT=hysteria-server.service

main() {
  init_common
  VPN_PROTOCOL="hy2"
  need_root

  log ""
  log "=============================================="
  log "  vpn-skill · Hysteria2 (QUIC/TLS) 部署"
  log "=============================================="
  info "系统: $(detect_os) / 架构: $(detect_arch)"

  VPN_SNI="${USER_VPN_SNI:-${VPN_SNI:-bing.com}}"
  VPN_PORT="$(resolve_port udp "$UNIT")"
  VPN_PASSWORD="$(resolve_secret "${VPN_PASSWORD:-}")"
  VPN_TAG="${VPN_TAG:-vpn-skill-hy2}"
  VPN_HOST="$(get_public_ip)"
  [ "$VPN_HOST" = "unknown" ] && warn "未能确定服务器地址，客户端将无法连接（请用 VPN_SERVER_IP 指定）"

  install_pkgs curl wget openssl ca-certificates
  install_hysteria
  make_cert
  render_config
  svc_apply_if_needed "$UNIT" "hysteria server"
  open_firewall "$VPN_PORT" udp

  VPN_LINK="hysteria2://${VPN_PASSWORD}@${VPN_HOST}:${VPN_PORT}/?insecure=1&sni=${VPN_SNI}#${VPN_TAG}"

  set_kv VPN_SKILL_VERSION "$VPN_SKILL_VERSION"
  set_kv VPN_PROTOCOL      "hy2"
  set_kv VPN_HOST          "$VPN_HOST"
  set_kv VPN_PORT          "$VPN_PORT"
  set_kv VPN_PASSWORD      "$VPN_PASSWORD"
  set_kv VPN_SNI           "$VPN_SNI"
  set_kv VPN_TRANSPORT     "quic"
  set_kv VPN_SKIP_CERT     "1"
  set_kv VPN_SERVICE       "$UNIT"
  set_kv VPN_TAG           "$VPN_TAG"
  set_kv VPN_LINK          "$VPN_LINK"
  set_kv VPN_INSTALLED_AT  "$(date +%s)"
  write_state

  log ""
  ok "Hysteria2 部署完成"
  log "  服务器 : ${C_YELLOW}${VPN_HOST}${C_RST}"
  log "  端口   : ${C_YELLOW}${VPN_PORT}/UDP${C_RST}"
  log "  密码   : ${C_YELLOW}${VPN_PASSWORD}${C_RST}"
  log "  SNI    : ${C_YELLOW}${VPN_SNI}${C_RST}（自签证书，客户端需跳过校验）"
  log "  链接   : ${C_GREEN}${VPN_LINK}${C_RST}"
  log ""
  if [ "${VPN_DRY_RUN:-0}" != "1" ]; then
    log "  管理: systemctl {status|restart|stop} ${UNIT}"
    log "  提醒: 若为云主机，请确认安全组已放行 ${VPN_PORT}/UDP"
  fi
  emit_state
}

install_hysteria() {
  mkdir -p "$WORKDIR" "$CONF_DIR"
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    info "dry-run: 跳过 hysteria 二进制安装"
    return 0
  fi
  if [ -x "$BIN" ]; then
    ok "已存在 hysteria: $("$BIN" version 2>/dev/null | head -1 || echo unknown)"
    write_unit_if_missing
    return 0
  fi

  info "尝试官方安装脚本 get.hy2.sh"
  if download https://get.hy2.sh/ "$WORKDIR/install.sh" && bash "$WORKDIR/install.sh" >/dev/null 2>&1 && [ -x "$BIN" ]; then
    ok "官方脚本安装成功"
    write_unit_if_missing
    return 0
  fi

  warn "官方脚本不可用，回退到 GitHub Release 直连下载"
  local arch url asset
  arch="$(detect_arch)"
  case "$arch" in
    amd64) asset=amd64 ;; arm64) asset=arm64 ;; armv7) asset=arm ;; *) die "hysteria 不支持架构 $arch" ;;
  esac
  url="https://github.com/apernet/hysteria/releases/download/${HY2_RELEASE}/hysteria-linux-${asset}"
  download_first "$WORKDIR/hysteria" "$url" "https://ghproxy.net/${url}" "https://gh-proxy.com/${url}" \
    || die "hysteria 下载失败，请检查服务器外网出口"
  install -m 0755 "$WORKDIR/hysteria" "$BIN"
  id hysteria >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hysteria 2>/dev/null || true
  write_unit_if_missing
  ok "hysteria 已安装: $("$BIN" version 2>/dev/null | head -1 || echo unknown)"
}

write_unit_if_missing() {
  if [ "${VPN_DRY_RUN:-0}" != "1" ] && [ -f "/etc/systemd/system/$UNIT" ]; then return 0; fi
  mkdir -p "$WORKDIR"
  cat >"$WORKDIR/unit.$$" <<EOF
[Unit]
Description=Hysteria2 Server (vpn-skill)
Documentation=https://github.com/flymysql/vpn-skill
After=network.target nss-lookup.target

[Service]
Type=simple
ExecStart=$BIN server --config $CONF
WorkingDirectory=$CONF_DIR
$(id hysteria >/dev/null 2>&1 && echo 'User=hysteria' || true)
LimitNOFILE=1048576
LimitNPROC=1048576
Restart=on-failure
RestartSec=3s
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
  apply_unit "$WORKDIR/unit.$$" "$UNIT"
}

make_cert() {
  mkdir -p "$CONF_DIR"
  if [ -s "$CONF_DIR/server.crt" ] && [ -s "$CONF_DIR/server.key" ]; then
    ok "复用已有自签证书"
    return 0
  fi
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    info "dry-run: 跳过证书生成"
    return 0
  fi
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$CONF_DIR/server.key" -out "$CONF_DIR/server.crt" \
    -subj "/CN=${VPN_SNI}" -days 36500 >/dev/null 2>&1 \
    || die "自签证书生成失败（openssl 不可用？）"
  chmod 600 "$CONF_DIR/server.key"
  chmod 644 "$CONF_DIR/server.crt"
  if id hysteria >/dev/null 2>&1; then chown hysteria:hysteria "$CONF_DIR/server.key" "$CONF_DIR/server.crt"; fi
  ok "已生成自签证书 CN=${VPN_SNI}"
}

render_config() {
  mkdir -p "$CONF_DIR"
  local tmp="$WORKDIR/config.yaml.$$"
  cat >"$tmp" <<EOF
# vpn-skill · Hysteria2（由 server/hy2.sh 生成；此处刻意不含时间戳，
# 否则每次重跑都会被视为「配置变更」而打断在线连接）
listen: :${VPN_PORT}

tls:
  cert: ${CONF_DIR}/server.crt
  key: ${CONF_DIR}/server.key

auth:
  type: password
  password: ${VPN_PASSWORD}

# 未通过认证的探测流量反向代理到真实站点，降低被主动探测识别的概率
masquerade:
  type: proxy
  proxy:
    url: https://${VPN_SNI}
    rewriteHost: true

# 服务端不限制客户端带宽（避免默认限速导致测速偏低）
ignoreClientBandwidth: true

quic:
  initStreamReceiveWindow: 26843545
  maxStreamReceiveWindow: 26843545
  initConnReceiveWindow: 67108864
  maxConnReceiveWindow: 67108864
EOF
  apply_config "$tmp" "$CONF" 0644

  # 附带一份客户端 JSON（与上游行为保持一致，便于手工排障）
  cat >"$CONF_DIR/hyclient.json" <<EOF
{
  "server": "${VPN_HOST}:${VPN_PORT}",
  "auth": "${VPN_PASSWORD}",
  "tls": { "sni": "${VPN_SNI}", "insecure": true },
  "quic": { "initStreamReceiveWindow": 26843545, "maxStreamReceiveWindow": 26843545, "initConnReceiveWindow": 67108864, "maxConnReceiveWindow": 67108864 }
}
EOF
}

main "$@"
