#!/usr/bin/env bash
# vpn-skill :: server/uninstall.sh — 卸载服务端（停服务、删配置、关端口放行）
set -euo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_HERE/common.sh" ] && . "$_HERE/common.sh"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RST=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; YELLOW=""; RST=""; }

[ "$(id -u)" = "0" ] || { printf '%s需要 root%s\n' "$RED" "$RST" >&2; exit 1; }

STATE_FILE="/etc/vpn-skill/state.env"
PORT=""; PROTO=""; SERVICE=""
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  PORT="${VPN_PORT:-}"; PROTO="${VPN_PROTOCOL:-}"; SERVICE="${VPN_SERVICE:-}"
fi

printf '即将卸载 vpn-skill 服务端 (protocol=%s, port=%s)\n' "${PROTO:-unknown}" "${PORT:-unknown}"

# 1. 停服务
for u in hysteria-server shadowsocks xray; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${u}\.service"; then
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    printf '  已停止 %s\n' "$u"
  fi
  rm -f "/etc/systemd/system/${u}.service"
done
systemctl daemon-reload >/dev/null 2>&1 || true

# 2. 删配置
rm -rf /etc/hysteria /etc/shadowsocks /usr/local/etc/xray /etc/vpn-skill
printf '  已删除配置目录\n'

# 3. 收端口放行
if [ -n "$PORT" ]; then
  if command -v ufw >/dev/null 2>&1; then
    for p in tcp udp; do ufw delete allow "${PORT}/${p}" >/dev/null 2>&1 || true; done
  fi
  if command -v firewall-cmd >/dev/null 2>&1; then
    for p in tcp udp; do firewall-cmd --permanent --remove-port="${PORT}/${p}" >/dev/null 2>&1 || true; done
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
  if command -v iptables >/dev/null 2>&1; then
    for p in tcp udp; do
      iptables -D INPUT -p "$p" --dport "$PORT" -j ACCEPT >/dev/null 2>&1 || true
    done
  fi
  printf '  已回收端口放行 %s\n' "$PORT"
fi

printf '%s卸载完成%s（二进制保留：/usr/local/bin/{hysteria,ssserver,xray}，如需彻底清除请手工删除）\n' "$GREEN" "$RST"
