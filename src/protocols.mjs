// vpn-skill :: src/protocols.mjs
// 服务端 state → 本机客户端配置（mihomo / Clash.Meta 单一内核同时吃下 hy2 / ss / vless-reality）
import { c, log } from './util.mjs';

// ---------------------------------------------------------------------------
// 极简 YAML 输出（值统一单引号包裹，规避所有转义坑；mihomo 的 YAML 解析器通吃）
// ---------------------------------------------------------------------------
const plain = /^-?\d+(\.\d+)?$/;

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const inner = toYaml(item, indent + 2);
          return `${pad}- ${inner.trimStart()}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys
      .map((k) => {
        const v = value[k];
        if (v && typeof v === 'object') {
          const inner = toYaml(v, indent + 2);
          if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
          if (Array.isArray(v)) return `${pad}${k}:\n${inner}`;
          return `${pad}${k}:\n${inner}`;
        }
        return `${pad}${k}: ${yamlScalar(v)}`;
      })
      .join('\n');
  }
  return `${pad}${yamlScalar(value)}`;
}

// ---------------------------------------------------------------------------
// state 归一化
// ---------------------------------------------------------------------------
export function normalizeState(raw = {}) {
  const g = (k, d = '') => (raw[k] === undefined || raw[k] === null ? d : String(raw[k]));
  return {
    raw,
    protocol: g('VPN_PROTOCOL').toLowerCase(),
    host: g('VPN_HOST'),
    port: Number(g('VPN_PORT', '0')),
    password: g('VPN_PASSWORD'),
    sni: g('VPN_SNI'),
    method: g('VPN_SS_METHOD'),
    uuid: g('VPN_UUID'),
    publicKey: g('VPN_PUBLIC_KEY'),
    shortId: g('VPN_SHORT_ID'),
    flow: g('VPN_FLOW', 'xtls-rprx-vision'),
    fingerprint: g('VPN_FP', 'chrome'),
    realityDest: g('VPN_REALITY_DEST'),
    transport: g('VPN_TRANSPORT'),
    skipCert: g('VPN_SKIP_CERT') === '1',
    service: g('VPN_SERVICE'),
    tag: g('VPN_TAG', 'vpn-skill'),
    link: g('VPN_LINK'),
    installedAt: Number(g('VPN_INSTALLED_AT', '0')),
    version: g('VPN_SKILL_VERSION'),
  };
}

export function validateState(s) {
  const errs = [];
  if (!['hy2', 'ss', 'reality'].includes(s.protocol)) errs.push(`未知协议: ${s.protocol || '(空)'}`);
  if (!s.host) errs.push('缺少服务器地址');
  if (!s.port) errs.push('缺少端口');
  if (s.protocol === 'hy2' && !s.password) errs.push('缺少 hy2 密码');
  if (s.protocol === 'ss' && (!s.password || !s.method)) errs.push('缺少 SS 密码/加密方式');
  if (s.protocol === 'reality' && (!s.uuid || !s.publicKey || !s.shortId)) errs.push('缺少 Reality uuid/pbk/sid');
  return errs;
}

// ---------------------------------------------------------------------------
// mihomo 代理节点
// ---------------------------------------------------------------------------
export function mihomoProxy(s, name) {
  const nodeName = name || s.tag || `vpn-skill-${s.protocol}`;
  switch (s.protocol) {
    case 'hy2':
      return {
        name: nodeName,
        type: 'hysteria2',
        server: s.host,
        port: s.port,
        password: s.password,
        sni: s.sni || 'bing.com',
        'skip-cert-verify': s.skipCert,
        udp: true,
      };
    case 'ss':
      return {
        name: nodeName,
        type: 'ss',
        server: s.host,
        port: s.port,
        cipher: s.method || 'aes-128-gcm',
        password: s.password,
        udp: true,
      };
    case 'reality':
      return {
        name: nodeName,
        type: 'vless',
        server: s.host,
        port: s.port,
        uuid: s.uuid,
        network: 'tcp',
        tls: true,
        udp: true,
        flow: s.flow,
        servername: s.sni,
        'client-fingerprint': s.fingerprint,
        'reality-opts': {
          'public-key': s.publicKey,
          'short-id': s.shortId,
        },
      };
    default:
      throw new Error(`不支持的协议: ${s.protocol}`);
  }
}

const PRIVATE_RULES = [
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
  'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
];

export function buildRules(s) {
  const rules = [...PRIVATE_RULES];
  // 代理节点自身必须直连，否则形成自环
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s.host)) {
    rules.unshift(`IP-CIDR,${s.host}/32,DIRECT,no-resolve`);
  }
  rules.push('MATCH,PROXY');
  return rules;
}

/**
 * 生成 mihomo 配置。
 * 默认不启用 TUN（TUN 需要管理员 + wintun 驱动），走「本地混合端口 + 系统代理」这条最稳的路。
 */
export function buildMihomoConfig(s, opts = {}) {
  const proxyPort = opts.proxyPort ?? 7890;
  const controllerPort = opts.controllerPort ?? 9090;
  const secret = opts.secret ?? '';
  const nodeName = opts.nodeName || s.tag || `vpn-skill-${s.protocol}`;

  const cfg = {
    'mixed-port': proxyPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': opts.logLevel || 'warning',
    'find-process-mode': 'off',
    ipv6: opts.ipv6 === true,
    'unified-delay': true,
    'tcp-concurrent': true,
    'geodata-mode': false,
    'geo-auto-update': false,
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: [mihomoProxy(s, nodeName)],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: [nodeName, 'DIRECT'] }],
    rules: buildRules(s),
  };

  if (opts.tun) {
    cfg['dns'] = {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter': ['*.lan', '*.local', 'localhost.ptlogin2.qq.com', 'time.*.com', 'ntp.*.com', '*.msftncsi.com', '*.msftconnecttest.com'],
      nameserver: ['223.5.5.5', '119.29.29.29'],
    };
    cfg['tun'] = {
      enable: true,
      stack: 'mixed',
      device: 'vpn-skill',
      'auto-route': true,
      'auto-detect-interface': true,
      'dns-hijack': ['any:53'],
      'strict-route': false,
    };
    cfg['sniffer'] = { enable: true, sniff: { TLS: { ports: [443, 8443] }, HTTP: { ports: [80, '8080-8880'], 'override-destination': true } } };
  } else {
    cfg['dns'] = { enable: false };
  }

  return `${toYaml(cfg)}\n`;
}

/**
 * 给 GUI 客户端（Clash Verge / ClashX / Stash / NekoBox）用的订阅片段。
 * 不带端口/控制器，只含节点与规则，避免覆盖客户端自身的端口设置。
 */
export function buildSubscription(states) {
  const list = Array.isArray(states) ? states : [states];
  const names = [];
  const proxies = list.map((s) => {
    const name = s.tag || `vpn-skill-${s.protocol}`;
    names.push(name);
    return mihomoProxy(s, name);
  });
  const cfg = {
    proxies,
    'proxy-groups': [
      { name: 'PROXY', type: 'select', proxies: [...names, 'DIRECT'] },
      { name: 'AUTO', type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, proxies: names },
    ],
    rules: buildRules(list[0]),
  };
  return `${toYaml(cfg)}\n`;
}

// ---------------------------------------------------------------------------
// 分享链接（手机端导入）
// ---------------------------------------------------------------------------
export function buildLink(s) {
  if (s.link) return s.link;
  const tag = s.tag || `vpn-skill-${s.protocol}`;
  switch (s.protocol) {
    case 'hy2':
      return `hysteria2://${s.password}@${s.host}:${s.port}/?insecure=${s.skipCert ? 1 : 0}&sni=${s.sni}#${tag}`;
    case 'ss': {
      const b64 = Buffer.from(`${s.method}:${s.password}`).toString('base64url');
      return `ss://${b64}@${s.host}:${s.port}#${tag}`;
    }
    case 'reality':
      return (
        `vless://${s.uuid}@${s.host}:${s.port}?encryption=none&flow=${s.flow}&security=reality` +
        `&sni=${s.sni}&fp=${s.fingerprint}&pbk=${s.publicKey}&sid=${s.shortId}&type=tcp&headerType=none#${tag}`
      );
    default:
      return '';
  }
}

export function printStateCfgHelp(protocol) {
  const hints = {
    hy2: '推荐客户端: v2rayN / NekoBox / Shadowrocket / Clash Verge（Hysteria2 需较新内核）',
    ss: '推荐客户端: 任意 SS 客户端 / Shadowrocket / Clash Verge',
    reality: '推荐客户端: v2rayN(xray 内核) / NekoBox / Shadowrocket / Clash Verge(Meta 内核)',
  };
  log(c.dim(`  ${hints[protocol] || ''}`));
}

export const SUPPORTED = ['hy2', 'ss', 'reality'];
