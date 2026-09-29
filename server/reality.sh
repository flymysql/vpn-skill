#!/usr/bin/env bash
# vpn-skill :: server/reality.sh — VLESS + XTLS-Reality 非交互部署
#
# 上游对应: chugzb/VPN/reality.sh（773 行交互式菜单）
# 本脚本差异: 零交互 / 密钥从既有 xray 配置回读（重跑不会作废客户端）/ 配置先 -test 校验再上线
#
# 隐蔽性最强的一档：握手伪装成对 dest 站点的真实 TLS，抗主动探测与 SNI 阻断。
set -euo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$_HERE/common.sh"
trap 'finish_common' EXIT

XRAY_RELEASE="${VPN_XRAY_RELEASE:-v26.3.27}"
CONF_DIR="${VPN_CONF_DIR:-/usr/local/etc/xray}"
CONF="$CONF_DIR/config.json"
BIN=/usr/local/bin/xray
UNIT=xray.service

main() {
  init_common
  VPN_PROTOCOL="reality"
  need_root

  log ""
  log "=============================================="
  log "  vpn-skill · VLESS + XTLS-Reality 部署"
  log "=============================================="
  info "系统: $(detect_os) / 架构: $(detect_arch)"

  VPN_REALITY_DEST="${USER_VPN_REALITY_DEST:-${VPN_REALITY_DEST:-www.microsoft.com:443}}"
  VPN_SNI="${USER_VPN_SNI:-${VPN_SNI:-${VPN_REALITY_DEST%%:*}}}"

  install_pkgs curl wget ca-certificates unzip
  install_xray
  install_xray_unit_if_missing

  # 端口：显式指定 > 历史状态 > 优先 443（伪装成 HTTPS，抗封锁最好）
  if [ -n "${USER_VPN_PORT:-}" ] || { [ "${STATE_LOADED:-0}" = "1" ] && [ -n "${STATE_PORT:-}" ]; }; then
    VPN_PORT="$(resolve_port tcp "$UNIT")"
  elif ! port_in_use 443 tcp; then
    VPN_PORT=443
    info "选用默认端口 443（与真实 HTTPS 同端口，伪装度最高）"
  else
    VPN_PORT="$(resolve_port tcp "$UNIT")"
    warn "443 已被占用，改用随机端口 $VPN_PORT"
  fi

  VPN_UUID="$(resolve_secret "${VPN_UUID:-}")"
  VPN_SHORT_ID="${VPN_SHORT_ID:-$(rand_hex 4)}"
  VPN_TAG="${VPN_TAG:-vpn-skill-reality}"
  VPN_HOST="$(get_public_ip)"
  [ "$VPN_HOST" = "unknown" ] && warn "未能确定服务器地址，客户端将无法连接（请用 VPN_SERVER_IP 指定）"

  resolve_reality_keys
  render_config
  validate_config
  svc_apply_if_needed "$UNIT" "$BIN"
  open_firewall "$VPN_PORT" tcp
  enable_bbr

  VPN_LINK="vless://${VPN_UUID}@${VPN_HOST}:${VPN_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${VPN_SNI}&fp=chrome&pbk=${VPN_PUBLIC_KEY}&sid=${VPN_SHORT_ID}&type=tcp&headerType=none#${VPN_TAG}"

  set_kv VPN_SKILL_VERSION "$VPN_SKILL_VERSION"
  set_kv VPN_PROTOCOL      "reality"
  set_kv VPN_HOST          "$VPN_HOST"
  set_kv VPN_PORT          "$VPN_PORT"
  set_kv VPN_UUID          "$VPN_UUID"
  set_kv VPN_PUBLIC_KEY    "$VPN_PUBLIC_KEY"
  set_kv VPN_SHORT_ID      "$VPN_SHORT_ID"
  set_kv VPN_SNI           "$VPN_SNI"
  set_kv VPN_REALITY_DEST  "$VPN_REALITY_DEST"
  set_kv VPN_FLOW          "xtls-rprx-vision"
  set_kv VPN_FP            "chrome"
  set_kv VPN_TRANSPORT     "tcp"
  set_kv VPN_SERVICE       "$UNIT"
  set_kv VPN_TAG           "$VPN_TAG"
  set_kv VPN_LINK          "$VPN_LINK"
  set_kv VPN_INSTALLED_AT  "$(date +%s)"
  write_state

  log ""
  ok "VLESS + Reality 部署完成"
  log "  服务器   : ${C_YELLOW}${VPN_HOST}${C_RST}"
  log "  端口     : ${C_YELLOW}${VPN_PORT}/TCP${C_RST}"
  log "  UUID     : ${C_YELLOW}${VPN_UUID}${C_RST}"
  log "  公钥 pbk : ${C_YELLOW}${VPN_PUBLIC_KEY}${C_RST}"
  log "  shortId  : ${C_YELLOW}${VPN_SHORT_ID}${C_RST}"
  log "  伪装 SNI : ${C_YELLOW}${VPN_SNI}${C_RST}  (dest=${VPN_REALITY_DEST})"
  log "  链接     : ${C_GREEN}${VPN_LINK}${C_RST}"
  log ""
  if [ "${VPN_DRY_RUN:-0}" != "1" ]; then
    log "  管理: systemctl {status|restart|stop} ${UNIT}"
    log "  提醒: 若为云主机，请确认安全组已放行 ${VPN_PORT}/TCP"
  fi
  emit_state
}

install_xray() {
  mkdir -p "$WORKDIR" "$CONF_DIR"
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    info "dry-run: 跳过 xray 二进制安装"
    return 0
  fi
  if [ -x "$BIN" ]; then
    ok "已存在 xray: $("$BIN" version 2>/dev/null | head -1 || echo unknown)"
    return 0
  fi

  info "尝试官方安装脚本 Xray-install"
  if download https://github.com/XTLS/Xray-install/raw/main/install-release.sh "$WORKDIR/xray-install.sh" \
     && bash "$WORKDIR/xray-install.sh" install >/dev/null 2>&1 && [ -x "$BIN" ]; then
    ok "官方脚本安装成功"
    return 0
  fi

  warn "官方脚本不可用，回退到 GitHub Release 直连下载"
  local arch asset url
  arch="$(detect_arch)"
  case "$arch" in
    amd64) asset="Xray-linux-64.zip" ;; arm64) asset="Xray-linux-arm64-v8a.zip" ;;
    armv7) asset="Xray-linux-arm32-v7a.zip" ;; *) die "xray 不支持架构 $arch" ;;
  esac
  url="https://github.com/XTLS/Xray-core/releases/download/${XRAY_RELEASE}/${asset}"
  download_first "$WORKDIR/xray.zip" "$url" "https://ghproxy.net/${url}" "https://gh-proxy.com/${url}" \
    || die "xray 下载失败，请检查服务器外网出口"
  unzip -o -q "$WORKDIR/xray.zip" -d "$WORKDIR/xray" || die "解压 xray 失败"
  [ -f "$WORKDIR/xray/xray" ] || die "压缩包内未找到 xray 可执行文件"
  install -m 0755 "$WORKDIR/xray/xray" "$BIN"
  ok "xray 已安装: $("$BIN" version 2>/dev/null | head -1 || echo unknown)"
}

install_xray_unit_if_missing() {
  if [ "${VPN_DRY_RUN:-0}" != "1" ] && [ -f "/etc/systemd/system/$UNIT" ]; then return 0; fi
  mkdir -p "$WORKDIR"
  cat >"$WORKDIR/unit.$$" <<EOF
[Unit]
Description=Xray Service (vpn-skill)
Documentation=https://github.com/flymysql/vpn-skill
After=network.target nss-lookup.target

[Service]
Type=simple
ExecStart=$BIN run -config $CONF
Restart=on-failure
RestartSec=3s
LimitNOFILE=1048576
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  apply_unit "$WORKDIR/unit.$$" "$UNIT"
}

# 密钥策略：优先从既有 config.json 回读私钥（保证重跑不作废已下发的客户端配置），
# 公钥从 state.env 复用；只有全新部署才生成密钥对。
resolve_reality_keys() {
  local existing_priv="" derived
  if [ -s "$CONF" ]; then
    existing_priv="$(grep -o '"privateKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONF" 2>/dev/null \
      | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
  fi
  VPN_PRIVATE_KEY="${VPN_PRIVATE_KEY:-$existing_priv}"

  if [ -n "$VPN_PRIVATE_KEY" ] && [ -n "${VPN_PUBLIC_KEY:-}" ]; then
    ok "复用既有 Reality 密钥对（公钥 ${VPN_PUBLIC_KEY:0:8}…）"
    return 0
  fi

  if [ "${VPN_DRY_RUN:-0}" = "1" ] || [ ! -x "$BIN" ]; then
    warn "dry-run 或 xray 不可用，使用占位密钥对（仅用于配置生成自测）"
    VPN_PRIVATE_KEY="${VPN_PRIVATE_KEY:-$(rand_hex 32)}"
    VPN_PUBLIC_KEY="${VPN_PUBLIC_KEY:-$(rand_hex 32)}"
    return 0
  fi

  if [ -n "$VPN_PRIVATE_KEY" ]; then
    derived="$("$BIN" x25519 -i "$VPN_PRIVATE_KEY" 2>/dev/null || true)"
    VPN_PUBLIC_KEY="$(printf '%s\n' "$derived" | grep -iE 'password|public' | head -1 | sed -E 's/^[^:]*:[[:space:]]*//' | tr -d ' \r\n\t')"
  fi

  if [ -z "${VPN_PUBLIC_KEY:-}" ]; then
    local raw priv pub i=0
    while [ $i -lt 5 ]; do
      raw="$("$BIN" x25519 2>/dev/null || true)"
      priv="$(printf '%s\n' "$raw" | grep -iE 'private' | head -1 | sed -E 's/^[^:]*:[[:space:]]*//' | tr -d ' \r\n\t')"
      pub="$(printf '%s\n' "$raw" | grep -iE 'password' | head -1 | sed -E 's/^[^:]*:[[:space:]]*//' | tr -d ' \r\n\t')"
      [ -z "$pub" ] && pub="$(printf '%s\n' "$raw" | grep -iE 'public' | head -1 | sed -E 's/^[^:]*:[[:space:]]*//' | tr -d ' \r\n\t')"
      if [ ${#priv} -ge 40 ] && [ ${#pub} -ge 40 ]; then
        VPN_PRIVATE_KEY="$priv"; VPN_PUBLIC_KEY="$pub"; break
      fi
      i=$((i + 1)); sleep 1
    done
    [ -n "${VPN_PUBLIC_KEY:-}" ] || die "x25519 密钥生成失败（xray x25519 输出异常）"
    ok "已生成新的 Reality 密钥对"
  fi
  # 私钥仅落盘到 xray 配置，不进 state.env（本机侧不保存服务端私钥）
}

render_config() {
  mkdir -p "$CONF_DIR"
  local tmp="$WORKDIR/config.json.$$"
  cat >"$tmp" <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": ${VPN_PORT},
      "protocol": "vless",
      "settings": {
        "clients": [ { "id": "${VPN_UUID}", "flow": "xtls-rprx-vision" } ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${VPN_REALITY_DEST}",
          "xver": 0,
          "serverNames": [ "${VPN_SNI}" ],
          "privateKey": "${VPN_PRIVATE_KEY}",
          "shortIds": [ "${VPN_SHORT_ID}" ]
        }
      },
      "sniffing": { "enabled": true, "destOverride": [ "http", "tls", "quic" ] }
    }
  ],
  "outbounds": [ { "protocol": "freedom", "tag": "direct" } ]
}
EOF
  apply_config "$tmp" "$CONF" 0644
}

validate_config() {
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    info "dry-run: 跳过 xray -test 校验"
    return 0
  fi
  [ -x "$BIN" ] || return 0
  if "$BIN" run -test -config "$CONF" >/dev/null 2>&1; then
    ok "xray 配置校验通过（xray run -test）"
  else
    "$BIN" run -test -config "$CONF" 2>&1 | tail -20 >&2 || true
    die "xray 配置校验失败，已阻止上线"
  fi
}

main "$@"
