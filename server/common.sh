#!/usr/bin/env bash
# vpn-skill :: server/common.sh
#
# 服务端共享库。被 server/<protocol>.sh 通过 `source` 引入。
#
# 设计约束（与上游 chugzb/VPN 的交互式脚本的核心差异）：
#   1. 完全非交互 —— 任何地方都不允许出现 read/prompt，一切通过环境变量驱动
#   2. 幂等 —— 重复执行不新建密码、不改端口、不破坏已有客户端配置
#   3. 可 dry-run —— VPN_DRY_RUN=1 时不下载二进制、不启服务、不改防火墙，
#      只做「依赖探测 + 配置生成 + 状态输出」，供 CI/本机离线自测
#   4. 机器可读 —— 结果写 state.env，并在 stdout 打印状态文件路径与 JSON 块
#
# 环境变量契约（全部可选）：
#   VPN_PORT            监听端口（默认随机可用端口）
#   VPN_SERVER_IP       对外 IP/域名（默认自动探测，NAT 环境必须显式给）
#   VPN_PASSWORD        hy2/ss 密码（默认 UUID）
#   VPN_SNI             hy2 SNI / reality 伪装域名（默认 bing.com / www.microsoft.com）
#   VPN_REALITY_DEST    reality 回落目标（默认 www.microsoft.com:443）
#   VPN_SS_METHOD       SS 加密方式（默认 aes-128-gcm）
#   VPN_UUID            reality UUID（默认随机）
#   VPN_STATE_DIR       状态目录（默认 root→/etc/vpn-skill，非 root→$HOME/.vpn-skill）
#   VPN_FORCE=1         强制重装（默认复用已存在状态）
#   VPN_DRY_RUN=1       离线演练
#   VPN_TAG             客户端节点显示名（默认 vpn-skill-<protocol>）
#   VPN_BBR=0           关闭 BBR 优化（默认开启，仅 TCP 协议）
#   VPN_OPEN_FIREWALL=0 关闭防火墙自动放行
# shellcheck shell=bash

set -euo pipefail

VPN_SKILL_VERSION="1.0.0"
SSH_KEEPALIVE_MARK="##VPN_SKILL_STATE_FILE="

# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_DIM=""; C_RST=""
fi

# 输出通道约定（重要）：
#   stdout = 机器可读数据（端口、IP、state.env 标记、JSON 块），会被 CLI 解析
#   stderr = 人类可读日志
# 违反这条约定会造成严重 bug：例如 `PORT=$(resolve_port)` 里若往 stdout 打日志，
# 端口值就会被日志污染（实测踩过）。
log()  { printf '%s\n' "$*" >&2; }
info() { printf '%s[ .. ]%s %s\n' "$C_CYAN" "$C_RST" "$*" >&2; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RST" "$*" >&2; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RST" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --------------------------------------------------------------------------
# 环境快照：必须在载入已有状态之前抓取，用于区分「用户显式指定」与「状态回填」
# --------------------------------------------------------------------------
_capture_user_env() {
  local k
  for k in VPN_PORT VPN_SERVER_IP VPN_PASSWORD VPN_SNI VPN_REALITY_DEST \
           VPN_SS_METHOD VPN_UUID VPN_TAG VPN_STATE_DIR; do
    eval "USER_${k}=\${${k}:-}"
  done
}

# --------------------------------------------------------------------------
# 状态：state.env（KEY=value，可被 bash source，也可被 Node 直接解析）
# --------------------------------------------------------------------------
default_state_dir() {
  if [ "$(id -u)" = "0" ]; then printf '/etc/vpn-skill\n'; else printf '%s/.vpn-skill\n' "$HOME"; fi
}

WORKDIR="${VPN_WORKDIR:-/tmp/vpn-skill}"
VPN_UNIT_DIR="${VPN_UNIT_DIR:-$WORKDIR/units}"

# 用户在命令行显式给出的值优先于历史状态（否则 --vpn-port 会被旧状态吃掉）
_apply_user_overrides() {
  [ -n "${USER_VPN_TAG:-}" ]         && VPN_TAG="$USER_VPN_TAG"
  [ -n "${USER_VPN_PORT:-}" ]        && VPN_PORT="$USER_VPN_PORT"
  [ -n "${USER_VPN_SERVER_IP:-}" ]   && VPN_SERVER_IP="$USER_VPN_SERVER_IP"
  [ -n "${USER_VPN_PASSWORD:-}" ]    && VPN_PASSWORD="$USER_VPN_PASSWORD"
  [ -n "${USER_VPN_SNI:-}" ]         && VPN_SNI="$USER_VPN_SNI"
  [ -n "${USER_VPN_REALITY_DEST:-}" ] && VPN_REALITY_DEST="$USER_VPN_REALITY_DEST"
  [ -n "${USER_VPN_SS_METHOD:-}" ]   && VPN_SS_METHOD="$USER_VPN_SS_METHOD"
  [ -n "${USER_VPN_UUID:-}" ]        && VPN_UUID="$USER_VPN_UUID"
  return 0
}

# 顺序很关键：抓环境 → 定状态目录 → 载入历史状态 → 用命令行覆盖
init_common() {
  _capture_user_env
  : >"${KV_TMP:=$(mktemp)}"
  VPN_STATE_DIR="${USER_VPN_STATE_DIR:-${VPN_STATE_DIR:-$(default_state_dir)}}"
  export VPN_STATE_DIR
  STATE_FILE="$VPN_STATE_DIR/state.env"
  STATE_LOADED=0
  load_state || true
  _apply_user_overrides
  # --force / VPN_FORCE=1：即使配置字节未变也重写并重启服务。
  # 注意刻意「不」重新生成凭据 —— 重新生成会立刻作废所有已下发的客户端配置。
  if [ "${VPN_FORCE:-0}" = "1" ]; then CFG_CHANGED=1; fi
}

# 载入已有状态（幂等的关键）：已存在则回填端口/密码/UUID
load_state() {
  [ -f "$STATE_FILE" ] || return 1
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  STATE_LOADED=1
  STATE_PORT="${VPN_PORT:-}"
  STATE_PROTOCOL="${VPN_PROTOCOL:-}"
  info "发现已有部署状态: $STATE_FILE (protocol=${STATE_PROTOCOL:-?}, port=${STATE_PORT:-?})"
  return 0
}

state_ok() { [ -n "$(state_get "$1" 2>/dev/null)" ]; }

state_get() {
  [ -n "${KV_TMP:-}" ] && [ -s "$KV_TMP" ] || return 1
  awk -F'\t' -v k="$1" '$1==k{print $2}' "$KV_TMP" | tail -n 1
}

set_kv() { # key value
  local k="$1" v="$2"
  # 只放行「可无转义写入 state.env / JSON」的安全字符集。
  # 注意：这里刻意不用 case 的方括号模式 —— bash 对 `[!...=...]` 有词法歧义（会报 & 语法错误）。
  if printf '%s' "$v" | grep -qE '[^]A-Za-z0-9._:/@+,#?&=%[~-]'; then
    case "$k" in
      VPN_NOTE|VPN_WARN*) ;; # 自由文本字段走 JSON 转义通道
      *) die "状态字段 $k 含不安全字符，已拒绝写入: $v" ;;
    esac
  fi
  printf '%s\t%s\n' "$k" "$v" >>"$KV_TMP"
}

write_state() {
  mkdir -p "$VPN_STATE_DIR"
  local tmp="$STATE_FILE.tmp.$$"
  {
    printf '# vpn-skill state (v%s) — 由 server/%s.sh 自动生成\n' \
      "$VPN_SKILL_VERSION" "${VPN_PROTOCOL:-unknown}"
    printf '# 该文件同时被本机 CLI 解析；手工修改后需重启对应服务。\n'
    awk -F'\t' 'NF==2{ printf "%s=%s\n", $1, $2 }' "$KV_TMP"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$STATE_FILE"
  # 以 sudo 提权执行时（登录用户非 root），state.env 会变成 root:600，
  # 导致本机 CLI 用普通账号读不回来 —— 把属主让回调用者。
  if [ -n "${SUDO_UID:-}" ] && [ "${SUDO_UID}" != "0" ]; then
    chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$STATE_FILE" 2>/dev/null || true
    chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$VPN_STATE_DIR" 2>/dev/null || true
  fi
  ok "状态已写入 $STATE_FILE"
}

_json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

emit_state() {
  local first=1 k v
  mkdir -p "$VPN_STATE_DIR"
  printf '%s%s%s\n' "$SSH_KEEPALIVE_MARK" "$STATE_FILE" '##'
  printf '##VPN_SKILL_STATE_BEGIN##\n{\n'
  while IFS=$'\t' read -r k v; do
    [ -n "$k" ] || continue
    if [ $first -eq 0 ]; then printf ',\n'; fi
    first=0
    printf '  "%s": "%s"' "$k" "$(_json_escape "$v")"
  done <"$KV_TMP"
  printf '\n}\n##VPN_SKILL_STATE_END##\n'
}

# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
need_root() {
  if [ "$(id -u)" != "0" ]; then
    if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
      warn "非 root 且处于 dry-run，跳过 root 校验"
      return 0
    fi
    die "需要 root 权限（请用 sudo 或 root 登录）"
  fi
}

rand_hex() { # len
  local n="${1:-16}"
  if have openssl; then openssl rand -hex "$n"; else
    head -c "$((n * 2))" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

rand_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid
  elif have uuidgen; then uuidgen | tr 'A-Z' 'a-z'
  elif have openssl; then
    local h; h=$(openssl rand -hex 16)
    printf '%s-%s-%s-%s-%s\n' "${h:0:8}" "${h:8:4}" "${h:12:4}" "${h:16:4}" "${h:20:12}"
  else
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | \
      sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'
  fi
}

rand_port() { # lo hi
  local lo="${1:-2000}" hi="${2:-65000}"
  if have shuf; then shuf -i "${lo}-${hi}" -n 1
  else printf '%s\n' "$(( (RANDOM * 32768 + RANDOM) % (hi - lo + 1) + lo ))"; fi
}

port_in_use() { # port proto
  local p="$1" proto="${2:-tcp}"
  if have ss; then ss -lnH 2>/dev/null | awk '{print $1, $4}' | grep -qiE "^${proto}.*[:.]$p\$" && return 0
  elif have netstat; then netstat -ln 2>/dev/null | awk '{print $1, $4}' | grep -qiE "^${proto}.*[:.]$p\$" && return 0
  fi
  return 1
}

pick_port() { # proto [preferred]
  local proto="${1:-tcp}" pref="${2:-}" p=""
  if [ -n "$pref" ]; then
    case "$pref" in *[!0-9]*|'') die "端口非法: $pref" ;; esac
    [ "$pref" -ge 1 ] && [ "$pref" -le 65535 ] || die "端口越界: $pref"
    port_in_use "$pref" "$proto" && die "端口 $pref/$proto 已被占用，请换一个（--vpn-port）"
    printf '%s\n' "$pref"; return 0
  fi
  local i=0
  while [ $i -lt 20 ]; do
    p=$(rand_port 2000 65000)
    if ! port_in_use "$p" "$proto"; then printf '%s\n' "$p"; return 0; fi
    i=$((i + 1))
  done
  die "无法找到空闲端口"
}

detect_os() {
  OS_ID="unknown"; OS_LIKE=""
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"; OS_LIKE="${ID_LIKE:-}"; OS_NAME="${PRETTY_NAME:-$ID}"
  fi
  printf '%s\n' "${OS_NAME:-$(uname -s)}"
}

PKG=""
install_pkgs() {
  [ "${VPN_DRY_RUN:-0}" = "1" ] && { info "dry-run: 跳过依赖安装 ($*)"; return 0; }
  local pkgs="$*"
  if have apt-get; then PKG=apt
    DEBIAN_FRONTEND=noninteractive apt-get update -qq -y >/dev/null
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -qq -y $pkgs >/dev/null
  elif have dnf; then PKG=dnf
    dnf -q -y install $pkgs >/dev/null || dnf -q -y install epel-release >/dev/null && dnf -q -y install $pkgs >/dev/null
  elif have yum; then PKG=yum
    yum -q -y install epel-release >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    yum -q -y install $pkgs >/dev/null
  elif have zypper; then PKG=zypper; zypper -q -n install $pkgs >/dev/null
  elif have pacman; then PKG=pacman; pacman -Sy --noconfirm --needed $pkgs >/dev/null
  else
    warn "未识别的包管理器，请自行确保已安装: $pkgs"
    return 0
  fi
  ok "依赖就绪 ($PKG): $pkgs"
}

ensure_downloader() { have curl || have wget || install_pkgs curl; }

download() { # url dest  -> 0/1
  local url="$1" dest="$2"
  if have curl; then
    curl -fsSL --connect-timeout 15 --retry 2 --retry-delay 2 -o "$dest" "$url" 2>/dev/null
  elif have wget; then
    wget -q -T 15 -t 2 -O "$dest" "$url" 2>/dev/null
  else
    return 1
  fi
}

download_first() { # dest url...
  local dest="$1"; shift
  local u
  for u in "$@"; do
    info "下载 $u"
    if download "$u" "$dest" && [ -s "$dest" ]; then return 0; fi
    warn "下载失败，尝试下一个源"
  done
  return 1
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    armv7l|armv7) printf 'armv7\n' ;;
    i386|i686) printf '386\n' ;;
    *) die "不支持的 CPU 架构: $(uname -m)" ;;
  esac
}

# 端口决策：命令行 > 历史状态 > 随机空闲
# 注意「自己的服务正占着这个端口」不算冲突（幂等重跑必须能过）
resolve_port() { # proto [unit]
  local proto="${1:-tcp}" unit="${2:-}"
  if [ -n "${USER_VPN_PORT:-}" ]; then
    if port_in_use "$USER_VPN_PORT" "$proto"; then
      if [ -n "$unit" ] && [ "$USER_VPN_PORT" = "${STATE_PORT:-}" ] && svc_active "$unit"; then
        warn "端口 $USER_VPN_PORT 正由本服务占用，按幂等重跑处理"
      else
        die "端口 $USER_VPN_PORT/$proto 已被其它进程占用，请用 --vpn-port 另选"
      fi
    fi
    printf '%s\n' "$USER_VPN_PORT"
  elif [ "${STATE_LOADED:-0}" = "1" ] && [ -n "${STATE_PORT:-}" ]; then
    info "复用已有端口 ${STATE_PORT}（幂等）"
    printf '%s\n' "$STATE_PORT"
  else
    pick_port "$proto"
  fi
}

# 密钥决策：历史状态 > 新生成
resolve_secret() { # existing_value
  if [ -n "${1:-}" ]; then printf '%s\n' "$1"; else rand_uuid; fi
}

# --------------------------------------------------------------------------
# 防火墙 / 内核
# --------------------------------------------------------------------------
open_firewall() { # port proto
  local port="$1" proto="$2"
  [ "${VPN_OPEN_FIREWALL:-1}" = "0" ] && { info "跳过防火墙（VPN_OPEN_FIREWALL=0）"; return 0; }
  [ "${VPN_DRY_RUN:-0}" = "1" ] && { info "dry-run: 跳过防火墙放行 ${port}/${proto}"; return 0; }
  local done_any=0
  if have ufw && ufw status 2>/dev/null | grep -qi '^Status: active'; then
    ufw allow "${port}/${proto}" >/dev/null 2>&1 && { ok "ufw 放行 ${port}/${proto}"; done_any=1; }
  fi
  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${port}/${proto}" >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
    ok "firewalld 放行 ${port}/${proto}"; done_any=1
  fi
  if [ $done_any -eq 0 ] && have iptables; then
    if ! iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null; then
      iptables -I INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null && \
        { ok "iptables 放行 ${port}/${proto}"; done_any=1; }
    else
      ok "iptables 已放行 ${port}/${proto}"; done_any=1
    fi
  fi
  [ $done_any -eq 0 ] && warn "未检测到活跃的本地防火墙（云安全组仍需手动放行 ${port}/${proto}）"
  return 0
}

enable_bbr() {
  [ "${VPN_DRY_RUN:-0}" = "1" ] && return 0
  [ "${VPN_BBR:-1}" = "0" ] && { info "跳过 BBR（VPN_BBR=0）"; return 0; }
  if sysctl net.ipv4.tcp_congestion_control 2>/dev/null | grep -q bbr; then
    ok "BBR 已启用"; return 0
  fi
  cat >/etc/sysctl.d/99-vpn-skill.conf <<'EOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.core.rmem_max=33554432
net.core.wmem_max=33554432
net.ipv4.tcp_fastopen=3
EOF
  sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-vpn-skill.conf >/dev/null 2>&1 || true
  if sysctl net.ipv4.tcp_congestion_control 2>/dev/null | grep -q bbr; then ok "BBR 已启用"; else warn "BBR 启用失败（内核可能不支持，不影响连通性）"; fi
}

# --------------------------------------------------------------------------
# 服务器对外地址
# --------------------------------------------------------------------------
get_public_ip() {
  if [ -n "${USER_VPN_SERVER_IP:-}" ]; then printf '%s\n' "$USER_VPN_SERVER_IP"; return 0; fi
  if [ -n "${VPN_SERVER_IP:-}" ]; then printf '%s\n' "$VPN_SERVER_IP"; return 0; fi
  local ip=""
  if have curl; then
    ip=$(curl -s -4 --connect-timeout 8 http://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | awk -F= '$1=="ip"{print $2}' | tr -d '\r\n')
    [ -z "$ip" ] && ip=$(curl -s -4 --connect-timeout 8 https://api.ipify.org 2>/dev/null | tr -d '\r\n')
    [ -z "$ip" ] && ip=$(curl -s -4 --connect-timeout 8 https://ipinfo.io/ip 2>/dev/null | tr -d '\r\n')
  elif have wget; then
    ip=$(wget -qO- -T 8 https://api.ipify.org 2>/dev/null | tr -d '\r\n')
  fi
  if [ -z "$ip" ]; then
    warn "无法自动探测公网 IP（NAT/内网环境请用 VPN_SERVER_IP 显式指定）"
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
  fi
  printf '%s\n' "${ip:-unknown}"
}

# --------------------------------------------------------------------------
# systemd 封装（无 systemd 时降级为 nohup 前台守护）
# --------------------------------------------------------------------------
has_systemd() { have systemctl && [ -d /run/systemd/system ]; }

svc_apply() { # unit_name
  local unit="$1"
  [ "${VPN_DRY_RUN:-0}" = "1" ] && { info "dry-run: 跳过 systemctl enable/restart $unit"; return 0; }
  if has_systemd; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable "$unit" >/dev/null 2>&1 || true
    systemctl restart "$unit" || die "启动 $unit 失败，请查看: journalctl -u $unit -n 50"
    sleep 1
    systemctl is-active --quiet "$unit" && ok "服务 $unit 运行中" || die "服务 $unit 未处于 active"
  else
    warn "无 systemd，服务未托管，请用 nohup 自行拉起"
  fi
}

svc_active() { # unit_name
  if has_systemd; then systemctl is-active --quiet "$1" 2>/dev/null; else pgrep -f "$2" >/dev/null 2>&1; fi
}

# 写配置：内容未变则不落盘（幂等 + 不打断在线连接）
# CFG_CHANGED 在一次运行内只累加不清零 —— 只要有任何一份配置变过就要重启服务
CFG_CHANGED=0
apply_config() { # src dest [mode]
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    if [ "${VPN_FORCE:-0}" = "1" ]; then
      info "配置无变化，但 --force 生效，仍将重启服务: $2"
    else
      info "配置无变化: $2"
    fi
    rm -f "$1"
  else
    mkdir -p "$(dirname "$2")"
    install -m "${3:-0644}" "$1" "$2"
    rm -f "$1"
    CFG_CHANGED=1
    ok "配置已写入: $2"
  fi
}

# 仅在「服务未运行」或「配置变更」时重启，避免重复执行打断现有连接
svc_apply_if_needed() { # unit_name pgrep_pattern
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    if [ "$CFG_CHANGED" = "1" ]; then
      info "dry-run: 配置有变更，本应重启 $1"
    else
      info "dry-run: 配置无变更，本应保持 $1 运行（不打断连接）"
    fi
    return 0
  fi
  if [ "$CFG_CHANGED" = "0" ] && svc_active "$1" "$2"; then
    ok "服务 $1 已在运行且配置未变，无需重启"
    return 0
  fi
  svc_apply "$1"
}

# 安装 systemd 单元。dry-run 时落到工作目录，保证「演练」对宿主零副作用。
apply_unit() { # src unit_name
  if [ "${VPN_DRY_RUN:-0}" = "1" ]; then
    mkdir -p "$VPN_UNIT_DIR"
    install -m 0644 "$1" "$VPN_UNIT_DIR/$2"
    rm -f "$1"
    info "dry-run: 单元文件写入 $VPN_UNIT_DIR/$2（未安装到 /etc/systemd/system）"
    return 0
  fi
  apply_config "$1" "/etc/systemd/system/$2" 0644
  have systemctl && systemctl daemon-reload >/dev/null 2>&1 || true
}

finish_common() {
  rm -f "${KV_TMP:-}" 2>/dev/null || true
}
