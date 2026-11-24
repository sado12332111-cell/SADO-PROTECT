/**
 * ============================================================================
 * SADO PROTECT — FULL CONST ENTERPRISE DISCORD BOT & WEB DASHBOARD
 * Single-File Self-Contained Node.js + Express + Discord.js v14 Application
 * ============================================================================
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');

/* ============================================================================
 * 1. RUNTIME ENVIRONMENT & CONST CONFIGURATION
 * ============================================================================ */

const APP_CONSTANTS = Object.freeze({
  BRAND_NAME: 'SADO PROTECT',
  BRAND_TAGLINE: 'Cyber Command • Script & Key Protection Engine',
  DEFAULT_PORT: 3000,
  DATA_DIR: path.join(__dirname, 'data'),
  STORE_FILE: path.join(__dirname, 'data', 'sado-protect-store.json'),
  BACKUP_DIR: path.join(__dirname, 'data', 'backups'),
  MAX_AUDIT_LOGS: 400,
  MAX_REDEEM_LOGS: 400,
  MAX_EXEC_LOGS: 400,
  MAX_BACKUPS: 25,
  DISCORD_API_BASE: 'https://discord.com/api/v10',
  KEY_PREFIX: 'SADO',
  DEFAULT_ACCENT_HEX: '#f59e0b',
  DEFAULT_BG_HEX: '#05070c',
  DEFAULT_PANEL_COLOR: '#f59e0b',
  HTTP_TIMEOUT_MS: 12000,
  AUTO_SAVE_INTERVAL_MS: 60000
});

const RUNTIME_ENV = Object.freeze({
  port: Number.parseInt(process.env.PORT || String(APP_CONSTANTS.DEFAULT_PORT), 10) || APP_CONSTANTS.DEFAULT_PORT,
  discordToken: String(
    process.env.DISCORD_TOKEN ||
      process.env.BOT_TOKEN ||
      process.env.DISCORD_BOT_TOKEN ||
      ''
  ).trim(),
  clientId: String(
    process.env.CLIENT_ID ||
      process.env.DISCORD_CLIENT_ID ||
      process.env.APPLICATION_ID ||
      ''
  ).trim(),
  guildId: String(
    process.env.GUILD_ID ||
      process.env.DISCORD_GUILD_ID ||
      ''
  ).trim(),
  publicUrl: String(
    process.env.PUBLIC_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.APP_URL ||
      ''
  )
    .trim()
    .replace(/\/+$/g, ''),
  dashboardPass: String(process.env.DASHBOARD_PASS || process.env.ADMIN_PASS || '').trim(),
  nodeEnv: String(process.env.NODE_ENV || 'production').trim()
});

const DURATION_CATALOG = Object.freeze({
  '1h': Object.freeze({ key: '1h', label: '1 Saat', seconds: 3600 }),
  '6h': Object.freeze({ key: '6h', label: '6 Saat', seconds: 21600 }),
  '12h': Object.freeze({ key: '12h', label: '12 Saat', seconds: 43200 }),
  '1d': Object.freeze({ key: '1d', label: '1 Gün', seconds: 86400 }),
  '3d': Object.freeze({ key: '3d', label: '3 Gün', seconds: 259200 }),
  '7d': Object.freeze({ key: '7d', label: '7 Gün', seconds: 604800 }),
  '14d': Object.freeze({ key: '14d', label: '14 Gün', seconds: 1209600 }),
  '30d': Object.freeze({ key: '30d', label: '30 Gün', seconds: 2592000 }),
  '90d': Object.freeze({ key: '90d', label: '90 Gün', seconds: 7776000 }),
  lifetime: Object.freeze({ key: 'lifetime', label: 'Ömürlük (Lifetime)', seconds: null })
});

const DEFAULT_PANEL_BUTTONS = Object.freeze([
  Object.freeze({
    id: 'btn_get_script',
    actionKey: 'get_script',
    label: 'Get Script',
    emoji: '📜',
    style: 'primary',
    enabled: true,
    order: 0
  }),
  Object.freeze({
    id: 'btn_redeem_key',
    actionKey: 'redeem_key',
    label: 'Redeem Key',
    emoji: '🔑',
    style: 'success',
    enabled: true,
    order: 1
  }),
  Object.freeze({
    id: 'btn_get_role',
    actionKey: 'get_role',
    label: 'Get Role',
    emoji: '🎭',
    style: 'secondary',
    enabled: true,
    order: 2
  }),
  Object.freeze({
    id: 'btn_reset_hwid',
    actionKey: 'reset_hwid',
    label: 'Reset HWID',
    emoji: '🔄',
    style: 'danger',
    enabled: true,
    order: 3
  })
]);

const DEFAULT_SCRIPTS_SEED = Object.freeze([
  Object.freeze({
    id: 'scr_sado_hub_v1',
    name: 'SADO Hub Ultra v1',
    version: '1.0.0',
    description: 'Əsas SADO PROTECT qoruma və avtomatlaşdırma scripti.',
    luaCode: [
      '-- SADO PROTECT Protected Lua Payload',
      'print("[SADO PROTECT] Script uğurla yükləndi! Key:", tostring(script_key or "NO_KEY"))',
      'local Players = game:GetService("Players")',
      'local localPlayer = Players.LocalPlayer',
      'if localPlayer then',
      '  print("[SADO PROTECT] İstifadəçi:", localPlayer.Name, "| UserId:", localPlayer.UserId)',
      'end'
    ].join('\n'),
    obfuscatedCode: '',
    obfuscationLevel: 'None',
    hwidLock: true,
    keyRequired: true,
    active: true,
    executions: 0,
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 86400000 * 3
  }),
  Object.freeze({
    id: 'scr_sado_combat_pro',
    name: 'SADO Combat Engine Pro',
    version: '2.4.1',
    description: 'Yüksək performanslı döyüş və telemetriya modulu.',
    luaCode: [
      '-- SADO Combat Engine Pro Lua Module',
      'local RunService = game:GetService("RunService")',
      'print("[SADO COMBAT PRO] Aktivdir | Key:", tostring(script_key or "UNSET"))',
      'local heartbeatConn = RunService.Heartbeat:Connect(function()',
      '  -- Core combat tick placeholder',
      'end)',
      'task.delay(2, function()',
      '  if heartbeatConn then heartbeatConn:Disconnect() end',
      'end)'
    ].join('\n'),
    obfuscatedCode: '',
    obfuscationLevel: 'Medium',
    hwidLock: true,
    keyRequired: true,
    active: true,
    executions: 0,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000
  })
]);

const createInitialStore = () => ({
  guildConfig: {
    guildId: RUNTIME_ENV.guildId || '',
    guildName: '',
    guildIconUrl: '',
    panelChannelId: '',
    panelChannelName: '',
    panelMessageId: '',
    activePanelScriptId: 'scr_sado_hub_v1',
    logChannelId: '',
    buyerRoleId: '',
    autoRoleOnRedeem: true,
    antiAltEnabled: false,
    requireKeyForLoader: false,
    updatedAt: Date.now()
  },
  panelDesign: {
    title: '🛡️ SADO PROTECT — Script & Key Access Panel',
    description: [
      'Aşağıdakı düymələr vasitəsilə scriptinizi əldə edə, key aktivləşdirə, rol ala və ya HWID sıfırlaya bilərsiniz.',
      '• **Get Script** — `script_key` və `loadstring` birlikdə təqdim olunur.',
      '• **Redeem Key** — Key-inizi hesabınıza və cihazınıza bağlayın.',
      '• **Get Role** — Aktiv key/whitelist ilə rol əldə edin.',
      '• **Reset HWID** — HWID kilidini təhlükəsiz yeniləyin.'
    ].join('\n'),
    colorHex: APP_CONSTANTS.DEFAULT_PANEL_COLOR,
    footerText: 'SADO PROTECT Security System • 24/7 Protected',
    thumbnailUrl: '',
    bannerUrl: '',
    buttons: DEFAULT_PANEL_BUTTONS.map((b) => ({ ...b })),
    updatedAt: Date.now()
  },
  scripts: DEFAULT_SCRIPTS_SEED.map((s) => ({ ...s })),
  keys: [],
  whitelist: [],
  blacklist: [],
  auditLogs: [],
  redeemLogs: [],
  executionLogs: [],
  metrics: {
    totalLoaderRequests: 0,
    blockedRequests: 0,
    panelUpdatesCount: 0,
    startedAt: Date.now()
  }
});

/* ============================================================================
 * 2. PURE CONST UTILITY & VALIDATION HELPERS
 * ============================================================================ */

const nowMs = () => Date.now();

const generateUniqueId = (prefix = 'id') => {
  const randPart = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${Date.now().toString(36)}_${randPart}`;
};

const generateKeyCode = (prefix = APP_CONSTANTS.KEY_PREFIX) => {
  const cleanPrefix = String(prefix || APP_CONSTANTS.KEY_PREFIX)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'SADO';
  const seg1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const seg2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const seg3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${cleanPrefix}-${seg1}-${seg2}-${seg3}`;
};

const sanitizeHexColor = (input, fallback = APP_CONSTANTS.DEFAULT_PANEL_COLOR) => {
  const raw = String(input || '').trim();
  const normalized = raw.startsWith('#') ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    const r = normalized[1];
    const g = normalized[2];
    const b = normalized[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback.toLowerCase();
};

const hexColorToDecimal = (hexValue, fallbackHex = APP_CONSTANTS.DEFAULT_PANEL_COLOR) => {
  const validHex = sanitizeHexColor(hexValue, fallbackHex);
  return Number.parseInt(validHex.slice(1), 16);
};

const escapeHtmlText = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeLuaString = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');

const isValidDiscordSnowflake = (value) => /^\d{17,20}$/.test(String(value || '').trim());

const isValidHttpUrl = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const resolveDurationConfig = (durationKey) => {
  const cleanKey = String(durationKey || 'lifetime').trim().toLowerCase();
  const catalogEntry = DURATION_CATALOG[cleanKey] || DURATION_CATALOG.lifetime;
  const expiresAt = catalogEntry.seconds ? nowMs() + catalogEntry.seconds * 1000 : null;
  return {
    key: catalogEntry.key,
    label: catalogEntry.label,
    seconds: catalogEntry.seconds,
    expiresAt
  };
};

const isItemExpired = (item) => {
  if (!item || item.expiresAt === null || item.expiresAt === undefined) return false;
  const ts = Number(item.expiresAt);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return nowMs() > ts;
};

const formatRelativeRemaining = (expiresAt) => {
  if (!expiresAt) return 'Ömürlük';
  const diffMs = Number(expiresAt) - nowMs();
  if (diffMs <= 0) return 'Vaxtı bitib';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}g ${hours}s`;
  if (hours > 0) return `${hours}s ${mins}d`;
  return `${Math.max(1, mins)}d`;
};

const formatDateTimeAz = (ts) => {
  if (!ts) return '—';
  try {
    return new Date(Number(ts)).toLocaleString('az-AZ', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(ts);
  }
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = APP_CONSTANTS.HTTP_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
};

/* ============================================================================
 * 3. LUA CODE GENERATOR & ULTRA OBFUSCATOR ENGINE
 * ============================================================================ */

const buildProtectedLuaTemplate = ({
  scriptName,
  mode,
  antiDump,
  antiHttpSpy,
  hwidLock,
  keyCheck
}) => {
  const cleanName = escapeLuaString(scriptName || 'SADO Protected Script');
  const lines = [
    `-- ==========================================================================`,
    `-- ${cleanName} | Generated by ${APP_CONSTANTS.BRAND_NAME}`,
    `-- Mode: ${mode} | HWID Lock: ${hwidLock ? 'ENABLED' : 'DISABLED'} | Key Check: ${keyCheck ? 'ENABLED' : 'DISABLED'}`,
    `-- ==========================================================================`,
    `local _SADO = {}`,
    `_SADO.Name = "${cleanName}"`,
    `_SADO.Key = tostring(script_key or getgenv and getgenv().script_key or "")`
  ];

  if (keyCheck) {
    lines.push(
      `if _SADO.Key == "" or #_SADO.Key < 6 then`,
      `  warn("[${APP_CONSTANTS.BRAND_NAME}] Xəta: Etibarlı script_key daxil edilməyib!")`,
      `  return`,
      `end`
    );
  }

  if (antiDump) {
    lines.push(
      `local _debugRef = typeof(debug) == "table" and debug or nil`,
      `if _debugRef and type(_debugRef.getinfo) == "function" then`,
      `  pcall(function()`,
      `    local info = _debugRef.getinfo(1, "S")`,
      `    if info and info.what and info.what ~= "Lua" and info.what ~= "main" then`,
      `      error("[${APP_CONSTANTS.BRAND_NAME}] Environment hook detected")`,
      `    end`,
      `  end)`,
      `end`
    );
  }

  if (antiHttpSpy) {
    lines.push(
      `local _rawHttpGet = game.HttpGet`,
      `if type(_rawHttpGet) ~= "function" then`,
      `  error("[${APP_CONSTANTS.BRAND_NAME}] HttpGet integrity check failed")`,
      `end`
    );
  }

  if (hwidLock) {
    lines.push(
      `local _rbxSvc = game:GetService("RbxAnalyticsService")`,
      `local _hwidVal = "UNKNOWN_HWID"`,
      `pcall(function()`,
      `  if _rbxSvc and type(_rbxSvc.GetClientId) == "function" then`,
      `    _hwidVal = tostring(_rbxSvc:GetClientId())`,
      `  end`,
      `end)`,
      `_SADO.HWID = _hwidVal`
    );
  }

  if (mode === 'combat') {
    lines.push(
      `local _players = game:GetService("Players")`,
      `local _lp = _players.LocalPlayer`,
      `print("[${APP_CONSTANTS.BRAND_NAME}] Combat Module Initialized for:", _lp and _lp.Name or "Player")`
    );
  } else if (mode === 'esp_radar') {
    lines.push(
      `local _workspace = game:GetService("Workspace")`,
      `local _camera = _workspace.CurrentCamera`,
      `print("[${APP_CONSTANTS.BRAND_NAME}] ESP & Radar Engine Ready | Camera:", _camera and _camera.Name or "Default")`
    );
  } else if (mode === 'webhook_logger') {
    lines.push(
      `local _httpService = game:GetService("HttpService")`,
      `local _payload = _httpService:JSONEncode({ tool = "${APP_CONSTANTS.BRAND_NAME}", script = _SADO.Name, ts = os.time() })`,
      `print("[${APP_CONSTANTS.BRAND_NAME}] Telemetry Payload Prepared:", #_payload, "bytes")`
    );
  } else {
    lines.push(
      `local _players = game:GetService("Players")`,
      `print("[${APP_CONSTANTS.BRAND_NAME}] Hub Core Loaded Successfully | Players:", #_players:GetPlayers())`
    );
  }

  lines.push(`return _SADO`);
  return lines.join('\n');
};

const obfuscateLuaSource = (sourceCode, level = 'Medium') => {
  const rawCode = String(sourceCode || '').trim();
  if (!rawCode) return '';

  const cleanLevel = String(level || 'Medium');
  const bytes = Array.from(Buffer.from(rawCode, 'utf8'));

  if (cleanLevel === 'None') {
    return rawCode;
  }

  if (cleanLevel === 'Light') {
    const encoded = bytes.map((b) => String(b)).join(',');
    return [
      `-- ${APP_CONSTANTS.BRAND_NAME} Light Byte-Array Wrapper`,
      `local _b = {${encoded}}`,
      `local _out = table.create(#_b)`,
      `for i = 1, #_b do _out[i] = string.char(_b[i]) end`,
      `local _fn, _err = loadstring(table.concat(_out))`,
      `if not _fn then error(_err) end`,
      `return _fn()`
    ].join('\n');
  }

  const xorKey = (crypto.randomBytes(1)[0] % 190) + 33;
  const xoredBytes = bytes.map((b, idx) => ((b ^ xorKey) + (idx % 13)) % 256);
  const chunkSize = cleanLevel === 'Ultra' ? 18 : 28;
  const chunks = [];

  for (let i = 0; i < xoredBytes.length; i += chunkSize) {
    const slice = xoredBytes.slice(i, i + chunkSize).join(',');
    chunks.push(`{${slice}}`);
  }

  const varPayload = `_v_${crypto.randomBytes(3).toString('hex')}`;
  const varKey = `_k_${crypto.randomBytes(3).toString('hex')}`;
  const varAcc = `_a_${crypto.randomBytes(3).toString('hex')}`;
  const varIdx = `_i_${crypto.randomBytes(3).toString('hex')}`;

  return [
    `-- ${APP_CONSTANTS.BRAND_NAME} ${cleanLevel} Virtualized Loader`,
    `local ${varKey} = ${xorKey}`,
    `local ${varPayload} = {`,
    `  ${chunks.join(',\n  ')}`,
    `}`,
    `local ${varAcc} = {}`,
    `local ${varIdx} = 0`,
    `for _, _blk in ipairs(${varPayload}) do`,
    `  for _, _val in ipairs(_blk) do`,
    `    local _orig = bit32.bxor(((_val - (${varIdx} % 13) + 256) % 256), ${varKey})`,
    `    ${varAcc}[#${varAcc} + 1] = string.char(_orig)`,
    `    ${varIdx} = ${varIdx} + 1`,
    `  end`,
    `end`,
    `local _exec, _compileErr = loadstring(table.concat(${varAcc}))`,
    `if not _exec then error("[${APP_CONSTANTS.BRAND_NAME}] Loader Error: " .. tostring(_compileErr)) end`,
    `return _exec()`
  ].join('\n');
};

/* ============================================================================
 * 4. PERSISTENT STORE & AUDIT LOGGING ENGINE
 * ============================================================================ */

const normalizePanelButtons = (rawButtons) => {
  const sourceList = Array.isArray(rawButtons) && rawButtons.length > 0
    ? rawButtons
    : DEFAULT_PANEL_BUTTONS;

  const validActionKeys = new Set(['get_script', 'redeem_key', 'get_role', 'reset_hwid']);
  const validStyles = new Set(['primary', 'success', 'secondary', 'danger']);

  return sourceList
    .map((btn, idx) => {
      const actionKey = validActionKeys.has(String(btn?.actionKey || ''))
        ? String(btn.actionKey)
        : DEFAULT_PANEL_BUTTONS[idx % DEFAULT_PANEL_BUTTONS.length].actionKey;
      const defaultDef = DEFAULT_PANEL_BUTTONS.find((d) => d.actionKey === actionKey) || DEFAULT_PANEL_BUTTONS[0];
      const rawStyle = String(btn?.style || defaultDef.style).toLowerCase();
      return {
        id: String(btn?.id || defaultDef.id || generateUniqueId('btn')),
        actionKey,
        label: String(btn?.label || defaultDef.label).trim().slice(0, 80) || defaultDef.label,
        emoji: String(btn?.emoji || defaultDef.emoji).trim().slice(0, 16) || defaultDef.emoji,
        style: validStyles.has(rawStyle) ? rawStyle : defaultDef.style,
        enabled: btn?.enabled === false ? false : true,
        order: Number.isFinite(Number(btn?.order)) ? Number(btn.order) : idx
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((btn, index) => ({ ...btn, order: index }));
};

const normalizeStoreShape = (rawData) => {
  const base = createInitialStore();
  const src = rawData && typeof rawData === 'object' ? rawData : {};

  const guildConfig = {
    ...base.guildConfig,
    ...(src.guildConfig && typeof src.guildConfig === 'object' ? src.guildConfig : {}),
    guildId: String(
      src.guildConfig?.guildId ||
        RUNTIME_ENV.guildId ||
        base.guildConfig.guildId
    ).trim()
  };

  const panelDesignRaw = src.panelDesign && typeof src.panelDesign === 'object' ? src.panelDesign : {};
  const panelDesign = {
    title: String(panelDesignRaw.title || base.panelDesign.title).trim().slice(0, 256) || base.panelDesign.title,
    description:
      String(panelDesignRaw.description || base.panelDesign.description).trim().slice(0, 4000) ||
      base.panelDesign.description,
    colorHex: sanitizeHexColor(panelDesignRaw.colorHex, base.panelDesign.colorHex),
    footerText:
      String(panelDesignRaw.footerText || base.panelDesign.footerText).trim().slice(0, 256) ||
      base.panelDesign.footerText,
    thumbnailUrl: String(panelDesignRaw.thumbnailUrl || '').trim(),
    bannerUrl: String(panelDesignRaw.bannerUrl || '').trim(),
    buttons: normalizePanelButtons(panelDesignRaw.buttons),
    updatedAt: Number(panelDesignRaw.updatedAt) || nowMs()
  };

  const scripts = Array.isArray(src.scripts) && src.scripts.length > 0
    ? src.scripts.map((s) => ({
        id: String(s.id || generateUniqueId('scr')),
        name: String(s.name || 'Unnamed Script').trim().slice(0, 120),
        version: String(s.version || '1.0.0').trim().slice(0, 32),
        description: String(s.description || '').trim().slice(0, 500),
        luaCode: String(s.luaCode || ''),
        obfuscatedCode: String(s.obfuscatedCode || ''),
        obfuscationLevel: String(s.obfuscationLevel || 'None'),
        hwidLock: s.hwidLock === false ? false : true,
        keyRequired: s.keyRequired === false ? false : true,
        active: s.active === false ? false : true,
        executions: Number(s.executions) || 0,
        createdAt: Number(s.createdAt) || nowMs(),
        updatedAt: Number(s.updatedAt) || nowMs()
      }))
    : base.scripts;

  return {
    guildConfig,
    panelDesign,
    scripts,
    keys: Array.isArray(src.keys) ? src.keys : [],
    whitelist: Array.isArray(src.whitelist) ? src.whitelist : [],
    blacklist: Array.isArray(src.blacklist) ? src.blacklist : [],
    auditLogs: Array.isArray(src.auditLogs) ? src.auditLogs.slice(0, APP_CONSTANTS.MAX_AUDIT_LOGS) : [],
    redeemLogs: Array.isArray(src.redeemLogs) ? src.redeemLogs.slice(0, APP_CONSTANTS.MAX_REDEEM_LOGS) : [],
    executionLogs: Array.isArray(src.executionLogs) ? src.executionLogs.slice(0, APP_CONSTANTS.MAX_EXEC_LOGS) : [],
    metrics: {
      ...base.metrics,
      ...(src.metrics && typeof src.metrics === 'object' ? src.metrics : {})
    }
  };
};

let store = createInitialStore();
let storeWriteQueue = Promise.resolve();

const saveStore = async () => {
  storeWriteQueue = storeWriteQueue.then(async () => {
    try {
      await fsp.mkdir(APP_CONSTANTS.DATA_DIR, { recursive: true });
      const payload = JSON.stringify(store, null, 2);
      const tmpPath = `${APP_CONSTANTS.STORE_FILE}.tmp`;
      await fsp.writeFile(tmpPath, payload, 'utf8');
      await fsp.rename(tmpPath, APP_CONSTANTS.STORE_FILE);
    } catch (err) {
      console.error('[STORE SAVE ERROR]', err.message);
    }
  });
  return storeWriteQueue;
};

const createStoreBackupSnapshot = async (reason = 'manual') => {
  try {
    await fsp.mkdir(APP_CONSTANTS.BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = String(reason).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
    const fileName = `backup-${stamp}-${safeReason}.json`;
    const fullPath = path.join(APP_CONSTANTS.BACKUP_DIR, fileName);
    await fsp.writeFile(fullPath, JSON.stringify(store, null, 2), 'utf8');

    const files = await fsp.readdir(APP_CONSTANTS.BACKUP_DIR);
    const sorted = files
      .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const oldFile of sorted.slice(APP_CONSTANTS.MAX_BACKUPS)) {
      await fsp.unlink(path.join(APP_CONSTANTS.BACKUP_DIR, oldFile)).catch(() => {});
    }

    return { ok: true, fileName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

const loadStore = async () => {
  try {
    await fsp.mkdir(APP_CONSTANTS.DATA_DIR, { recursive: true });
    if (!fs.existsSync(APP_CONSTANTS.STORE_FILE)) {
      store = createInitialStore();
      await saveStore();
      return;
    }
    const rawContent = await fsp.readFile(APP_CONSTANTS.STORE_FILE, 'utf8');
    const parsed = JSON.parse(rawContent);
    store = normalizeStoreShape(parsed);
  } catch (err) {
    console.warn('[STORE LOAD WARNING] Yeni store başladılır:', err.message);
    store = createInitialStore();
    await saveStore();
  }
};

const appendAuditLog = async (actor, action, details) => {
  const entry = {
    id: generateUniqueId('aud'),
    actor: String(actor || 'System').slice(0, 100),
    action: String(action || 'INFO').slice(0, 80),
    details: String(details || '').slice(0, 500),
    createdAt: nowMs()
  };
  store.auditLogs.unshift(entry);
  if (store.auditLogs.length > APP_CONSTANTS.MAX_AUDIT_LOGS) {
    store.auditLogs.length = APP_CONSTANTS.MAX_AUDIT_LOGS;
  }
  await saveStore();
  return entry;
};

const appendRedeemLog = async (payload) => {
  const entry = {
    id: generateUniqueId('rdm'),
    userId: String(payload.userId || ''),
    userTag: String(payload.userTag || 'Unknown'),
    keyCode: String(payload.keyCode || ''),
    scriptName: String(payload.scriptName || ''),
    hwid: String(payload.hwid || ''),
    status: String(payload.status || 'success'),
    message: String(payload.message || ''),
    createdAt: nowMs()
  };
  store.redeemLogs.unshift(entry);
  if (store.redeemLogs.length > APP_CONSTANTS.MAX_REDEEM_LOGS) {
    store.redeemLogs.length = APP_CONSTANTS.MAX_REDEEM_LOGS;
  }
  await saveStore();
  return entry;
};

const appendExecutionLog = async (payload) => {
  const entry = {
    id: generateUniqueId('exe'),
    scriptId: String(payload.scriptId || ''),
    scriptName: String(payload.scriptName || ''),
    keyCode: String(payload.keyCode || ''),
    hwid: String(payload.hwid || ''),
    ipAddress: String(payload.ipAddress || ''),
    allowed: Boolean(payload.allowed),
    reason: String(payload.reason || ''),
    createdAt: nowMs()
  };
  store.executionLogs.unshift(entry);
  if (store.executionLogs.length > APP_CONSTANTS.MAX_EXEC_LOGS) {
    store.executionLogs.length = APP_CONSTANTS.MAX_EXEC_LOGS;
  }
  await saveStore();
  return entry;
};

/* ============================================================================
 * 5. DISCORD PROFILE & GUILD HELPER ENGINE
 * ============================================================================ */

const fetchDiscordUserProfile = async (discordId) => {
  const cleanId = String(discordId || '').trim();
  const fallbackProfile = {
    id: cleanId,
    username: cleanId ? `User_${cleanId.slice(-4)}` : 'Unknown',
    globalName: cleanId ? `User ${cleanId.slice(-4)}` : 'Unknown User',
    avatarUrl: ''
  };

  if (!isValidDiscordSnowflake(cleanId)) {
    return fallbackProfile;
  }

  try {
    if (discordClient && discordClient.isReady()) {
      const cached = discordClient.users.cache.get(cleanId) || (await discordClient.users.fetch(cleanId).catch(() => null));
      if (cached) {
        return {
          id: cached.id,
          username: cached.username,
          globalName: cached.globalName || cached.username,
          avatarUrl: cached.displayAvatarURL({ extension: 'png', size: 128 })
        };
      }
    }

    if (RUNTIME_ENV.discordToken) {
      const res = await fetchWithTimeout(`${APP_CONSTANTS.DISCORD_API_BASE}/users/${cleanId}`, {
        headers: {
          Authorization: `Bot ${RUNTIME_ENV.discordToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        const avatarUrl = data.avatar
          ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png?size=128`
          : '';
        return {
          id: data.id,
          username: data.username || fallbackProfile.username,
          globalName: data.global_name || data.username || fallbackProfile.globalName,
          avatarUrl
        };
      }
    }
  } catch {
    return fallbackProfile;
  }

  return fallbackProfile;
};

const getBasePublicUrl = (req) => {
  if (RUNTIME_ENV.publicUrl) {
    return RUNTIME_ENV.publicUrl;
  }
  if (req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || `localhost:${RUNTIME_ENV.port}`).trim();
    return `${proto}://${host}`;
  }
  return `http://localhost:${RUNTIME_ENV.port}`;
};

const isUserBlacklisted = (discordId, hwid = '') => {
  const cleanId = String(discordId || '').trim();
  const cleanHwid = String(hwid || '').trim().toLowerCase();

  return store.blacklist.some((entry) => {
    if (isItemExpired(entry)) return false;
    const matchDiscord = cleanId && String(entry.discordId || '').trim() === cleanId;
    const matchHwid = cleanHwid && String(entry.hwid || '').trim().toLowerCase() === cleanHwid;
    return matchDiscord || matchHwid;
  });
};

const getActiveWhitelistForUser = (discordId, scriptId = '') => {
  const cleanId = String(discordId || '').trim();
  if (!cleanId) return null;

  return (
    store.whitelist.find((entry) => {
      if (isItemExpired(entry)) return false;
      if (String(entry.discordId || '').trim() !== cleanId) return false;
      if (!scriptId) return true;
      return entry.scriptId === 'ALL' || entry.scriptId === scriptId;
    }) || null
  );
};

/* ============================================================================
 * 6. KEY, WHITELIST, BLACKLIST & SCRIPT BUNDLE DOMAIN OPERATIONS
 * ============================================================================ */

const buildGetScriptBundle = (scriptRecord, baseUrl, options = {}) => {
  const safeScript = scriptRecord || { id: 'scr_sado_hub_v1', name: 'SADO Hub Ultra v1' };
  const activeKeyObj = store.keys.find(
    (k) => k.scriptId === safeScript.id && k.status === 'active' && !isItemExpired(k)
  );
  const resolvedKey =
    String(options.scriptKey || '').trim() ||
    (activeKeyObj && activeKeyObj.code) ||
    'SADO-AUTO-GENERATED-KEY';

  const loaderUrl = `${baseUrl}/api/loader/${encodeURIComponent(safeScript.id)}?key=${encodeURIComponent(resolvedKey)}`;
  const scriptKeyLine = `script_key = "${escapeLuaString(resolvedKey)}";`;
  const loadstringLine = `loadstring(game:HttpGet("${escapeLuaString(loaderUrl)}", true))();`;
  const combinedScript = `${scriptKeyLine}\n${loadstringLine}`;

  return {
    scriptId: safeScript.id,
    scriptName: safeScript.name,
    scriptKey: resolvedKey,
    scriptKeyLine,
    loadstringLine,
    loaderUrl,
    combinedScript,
    copyBlock: `\`\`\`lua\n${combinedScript}\n\`\`\``
  };
};

const createKeyBatch = async ({
  scriptId,
  durationKey = 'lifetime',
  count = 1,
  prefix = APP_CONSTANTS.KEY_PREFIX,
  assignedUserId = '',
  createdByTag = 'Dashboard'
}) => {
  const scriptObj = store.scripts.find((s) => s.id === scriptId) || store.scripts[0];
  if (!scriptObj) {
    throw new Error('Heç bir script tapılmadı.');
  }

  const cleanCount = Math.min(Math.max(Number.parseInt(count, 10) || 1, 1), 100);
  const durInfo = resolveDurationConfig(durationKey);
  const cleanAssignedId = String(assignedUserId || '').trim();
  const createdKeys = [];

  for (let i = 0; i < cleanCount; i += 1) {
    let code = generateKeyCode(prefix);
    while (store.keys.some((existing) => existing.code === code)) {
      code = generateKeyCode(prefix);
    }

    const record = {
      id: generateUniqueId('key'),
      code,
      scriptId: scriptObj.id,
      scriptName: scriptObj.name,
      durationKey: durInfo.key,
      durationLabel: durInfo.label,
      expiresAt: durInfo.expiresAt,
      status: 'active',
      createdById: '',
      createdByTag,
      createdByAvatar: '',
      usedById: cleanAssignedId,
      usedByTag: cleanAssignedId ? `Assigned (${cleanAssignedId})` : '',
      usedByAvatar: '',
      hwid: '',
      autoGeneratedFromWhitelist: false,
      createdAt: nowMs(),
      redeemedAt: null
    };

    store.keys.unshift(record);
    createdKeys.push(record);
  }

  await saveStore();
  await appendAuditLog(
    createdByTag,
    'CREATE_KEYS',
    `Script=${scriptObj.name} | Say=${cleanCount} | Müddət=${durInfo.label} | İlk Key=${createdKeys[0]?.code || ''}`
  );

  return createdKeys;
};

const addWhitelistRecord = async ({
  discordId,
  discordTag = '',
  avatarUrl = '',
  durationKey = 'lifetime',
  scriptId = '',
  actorTag = 'Dashboard'
}) => {
  const cleanId = String(discordId || '').trim();
  if (!isValidDiscordSnowflake(cleanId)) {
    throw new Error('Düzgün 17-20 rəqəmli Discord ID daxil edin.');
  }

  const profile = await fetchDiscordUserProfile(cleanId);
  const durInfo = resolveDurationConfig(durationKey);
  const matchedScript = scriptId ? store.scripts.find((s) => s.id === scriptId) : null;
  const keyTargetScript = matchedScript || store.scripts[0] || { id: 'scr_sado_hub_v1', name: 'SADO Hub Ultra v1' };

  const autoKeyEntry = {
    id: generateUniqueId('key'),
    code: generateKeyCode(APP_CONSTANTS.KEY_PREFIX),
    scriptId: keyTargetScript.id,
    scriptName: keyTargetScript.name,
    durationKey: durInfo.key,
    durationLabel: durInfo.label,
    expiresAt: durInfo.expiresAt,
    status: 'active',
    createdById: '',
    createdByTag: `${actorTag} (Whitelist Auto-Key)`,
    createdByAvatar: profile.avatarUrl,
    usedById: cleanId,
    usedByTag: String(discordTag || profile.globalName || profile.username),
    usedByAvatar: String(avatarUrl || profile.avatarUrl),
    hwid: '',
    autoGeneratedFromWhitelist: true,
    createdAt: nowMs(),
    redeemedAt: nowMs()
  };

  store.keys = store.keys.filter(
    (k) => !(k.autoGeneratedFromWhitelist && k.usedById === cleanId && k.scriptId === keyTargetScript.id)
  );
  store.keys.unshift(autoKeyEntry);

  store.whitelist = store.whitelist.filter((w) => w.discordId !== cleanId);
  const wlEntry = {
    id: generateUniqueId('wl'),
    discordId: cleanId,
    discordTag: String(discordTag || profile.globalName || profile.username),
    avatarUrl: String(avatarUrl || profile.avatarUrl),
    scriptId: matchedScript ? matchedScript.id : 'ALL',
    scriptName: matchedScript ? matchedScript.name : 'Bütün Scriptlər',
    durationKey: durInfo.key,
    durationLabel: durInfo.label,
    expiresAt: durInfo.expiresAt,
    autoKeyCode: autoKeyEntry.code,
    addedBy: actorTag,
    createdAt: nowMs()
  };
  store.whitelist.unshift(wlEntry);

  await saveStore();
  await appendAuditLog(
    actorTag,
    'WHITELIST_ADD',
    `User=${wlEntry.discordTag} (${cleanId}) | AutoKey=${autoKeyEntry.code} | Script=${wlEntry.scriptName} | Müddət=${wlEntry.durationLabel}`
  );

  return {
    ...wlEntry,
    autoKey: autoKeyEntry
  };
};

const addBlacklistRecord = async ({
  discordId = '',
  hwid = '',
  reason = 'Qayda pozuntusu',
  durationKey = 'lifetime',
  actorTag = 'Dashboard'
}) => {
  const cleanId = String(discordId || '').trim();
  const cleanHwid = String(hwid || '').trim();

  if (!cleanId && !cleanHwid) {
    throw new Error('Discord ID və ya HWID daxil edilməlidir.');
  }
  if (cleanId && !isValidDiscordSnowflake(cleanId)) {
    throw new Error('Discord ID 17-20 rəqəmli olmalıdır.');
  }

  const profile = cleanId
    ? await fetchDiscordUserProfile(cleanId)
    : { id: '', username: 'HWID_TARGET', globalName: 'HWID Target', avatarUrl: '' };

  const durInfo = resolveDurationConfig(durationKey);

  store.blacklist = store.blacklist.filter((b) => {
    const sameDiscord = cleanId && b.discordId === cleanId;
    const sameHwid = cleanHwid && b.hwid && b.hwid.toLowerCase() === cleanHwid.toLowerCase();
    return !(sameDiscord || sameHwid);
  });

  const blEntry = {
    id: generateUniqueId('bl'),
    discordId: cleanId,
    discordTag: cleanId ? profile.globalName || profile.username : `HWID: ${cleanHwid.slice(0, 14)}`,
    avatarUrl: profile.avatarUrl,
    hwid: cleanHwid,
    reason: String(reason || 'Qayda pozuntusu').trim().slice(0, 250),
    durationKey: durInfo.key,
    durationLabel: durInfo.label,
    expiresAt: durInfo.expiresAt,
    addedBy: actorTag,
    createdAt: nowMs()
  };
  store.blacklist.unshift(blEntry);

  if (cleanId) {
    store.keys = store.keys.map((k) =>
      k.usedById === cleanId && k.status === 'active'
        ? { ...k, status: 'revoked', revokedReason: 'Blacklisted' }
        : k
    );
  }

  await saveStore();
  await appendAuditLog(
    actorTag,
    'BLACKLIST_ADD',
    `Target=${blEntry.discordTag} | HWID=${cleanHwid || '—'} | Səbəb=${blEntry.reason} | Müddət=${blEntry.durationLabel}`
  );

  return blEntry;
};

/* ============================================================================
 * 7. DISCORD BOT CLIENT, PANEL BUILDER & LIVE PANEL SYNC ENGINE
 * ============================================================================ */

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

let botRuntimeState = {
  ready: false,
  username: '',
  userId: '',
  avatarUrl: '',
  guildsCount: 0,
  lastError: '',
  lastReadyAt: null
};

const mapButtonStyleToDiscord = (styleName) => {
  const clean = String(styleName || '').toLowerCase();
  if (clean === 'success') return ButtonStyle.Success;
  if (clean === 'secondary') return ButtonStyle.Secondary;
  if (clean === 'danger') return ButtonStyle.Danger;
  return ButtonStyle.Primary;
};

const buildPanelMessagePayload = (scriptRecord) => {
  const targetScript =
    scriptRecord ||
    store.scripts.find((s) => s.id === store.guildConfig.activePanelScriptId) ||
    store.scripts[0] || { id: 'scr_sado_hub_v1', name: 'SADO Hub Ultra v1', version: '1.0.0' };

  const embedColor = hexColorToDecimal(store.panelDesign.colorHex, APP_CONSTANTS.DEFAULT_PANEL_COLOR);
  const embed = new EmbedBuilder()
    .setTitle(String(store.panelDesign.title || `${APP_CONSTANTS.BRAND_NAME} Panel`).slice(0, 256))
    .setDescription(String(store.panelDesign.description || 'Paneldən istifadə edin.').slice(0, 4096))
    .setColor(embedColor)
    .addFields(
      { name: '📜 Aktiv Script', value: `\`${targetScript.name}\` (\`v${targetScript.version || '1.0.0'}\`)`, inline: true },
      { name: '🛡️ Qoruma', value: '`HWID + Key + Anti-Hook`', inline: true },
      { name: '⚡ Status', value: '`Online • 24/7`', inline: true }
    )
    .setFooter({
      text: String(store.panelDesign.footerText || `${APP_CONSTANTS.BRAND_NAME} Security`).slice(0, 2048)
    })
    .setTimestamp();

  if (isValidHttpUrl(store.panelDesign.thumbnailUrl)) {
    embed.setThumbnail(store.panelDesign.thumbnailUrl);
  }
  if (isValidHttpUrl(store.panelDesign.bannerUrl)) {
    embed.setImage(store.panelDesign.bannerUrl);
  }

  const orderedButtons = normalizePanelButtons(store.panelDesign.buttons).filter((b) => b.enabled);
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (const btnCfg of orderedButtons.slice(0, 10)) {
    if (currentRow.components.length >= 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    const buttonBuilder = new ButtonBuilder()
      .setCustomId(`sp_action:${btnCfg.actionKey}:${targetScript.id}`)
      .setLabel(btnCfg.label)
      .setStyle(mapButtonStyleToDiscord(btnCfg.style));

    if (btnCfg.emoji) {
      buttonBuilder.setEmoji(btnCfg.emoji);
    }

    currentRow.addComponents(buttonBuilder);
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return {
    embeds: [embed],
    components: rows
  };
};

const syncExistingDiscordPanels = async (targetScriptRecord = null) => {
  try {
    if (!discordClient.isReady()) {
      return 0;
    }

    const channelId = String(store.guildConfig.panelChannelId || '').trim();
    const activeScript =
      targetScriptRecord ||
      store.scripts.find((s) => s.id === store.guildConfig.activePanelScriptId) ||
      store.scripts[0];

    if (!channelId || !activeScript) {
      return 0;
    }

    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return 0;
    }

    const payload = buildPanelMessagePayload(activeScript);
    let updatedCount = 0;

    if (store.guildConfig.panelMessageId) {
      const savedMsg = await channel.messages.fetch(store.guildConfig.panelMessageId).catch(() => null);
      if (savedMsg && savedMsg.author && savedMsg.author.id === discordClient.user?.id) {
        await savedMsg.edit(payload);
        updatedCount += 1;
      }
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recentMessages) {
      const botId = discordClient.user?.id || '';
      for (const [, msg] of recentMessages) {
        if (msg.id === store.guildConfig.panelMessageId) continue;
        if (msg.author && msg.author.id === botId && Array.isArray(msg.components) && msg.components.length > 0) {
          const isPanelMsg = msg.components.some((row) =>
            (row.components || []).some((comp) => String(comp.customId || '').startsWith('sp_action:'))
          );
          if (isPanelMsg) {
            await msg.edit(payload).catch(() => {});
            updatedCount += 1;
          }
        }
      }
    }

    if (updatedCount > 0) {
      store.metrics.panelUpdatesCount = (Number(store.metrics.panelUpdatesCount) || 0) + updatedCount;
      await saveStore();
    }

    return updatedCount;
  } catch (err) {
    console.warn('[PANEL SYNC WARNING]', err.message);
    return 0;
  }
};

const sendPanelToChannel = async ({ channelId, scriptId, actorTag = 'Dashboard' }) => {
  if (!discordClient.isReady()) {
    throw new Error('Discord bot hazır deyil. Token və internet bağlantısını yoxlayın.');
  }

  const cleanChannelId = String(channelId || store.guildConfig.panelChannelId || '').trim();
  if (!isValidDiscordSnowflake(cleanChannelId)) {
    throw new Error('Düzgün Discord kanal ID-si daxil edin.');
  }

  const channel = await discordClient.channels.fetch(cleanChannelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('Seçilən kanal mətn kanalı deyil və ya tapılmadı.');
  }

  const targetScript =
    store.scripts.find((s) => s.id === (scriptId || store.guildConfig.activePanelScriptId)) ||
    store.scripts[0];

  if (!targetScript) {
    throw new Error('Panelə bağlamaq üçün script tapılmadı.');
  }

  const payload = buildPanelMessagePayload(targetScript);
  const sentMessage = await channel.send(payload);

  store.guildConfig.panelChannelId = cleanChannelId;
  store.guildConfig.panelChannelName = channel.name || cleanChannelId;
  store.guildConfig.panelMessageId = sentMessage.id;
  store.guildConfig.activePanelScriptId = targetScript.id;
  if (channel.guild) {
    store.guildConfig.guildId = channel.guild.id;
    store.guildConfig.guildName = channel.guild.name;
    store.guildConfig.guildIconUrl = channel.guild.iconURL({ extension: 'png', size: 128 }) || '';
  }
  store.guildConfig.updatedAt = nowMs();

  await saveStore();
  await appendAuditLog(
    actorTag,
    'SEND_PANEL',
    `Kanal=#${channel.name || cleanChannelId} | Script=${targetScript.name} | MsgId=${sentMessage.id}`
  );

  return {
    messageId: sentMessage.id,
    channelId: cleanChannelId,
    channelName: channel.name || cleanChannelId,
    scriptName: targetScript.name
  };
};

const registerSlashCommands = async () => {
  const token = RUNTIME_ENV.discordToken;
  const appId = RUNTIME_ENV.clientId || discordClient.user?.id || '';
  if (!token || !appId) {
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('SADO PROTECT script & key panelini kanala göndər')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Panelin göndəriləcəyi kanal')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('genkey')
      .setDescription('Yeni script key yaradır')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((opt) =>
        opt.setName('duration').setDescription('Müddət (1h, 1d, 7d, 30d, lifetime)').setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName('count').setDescription('Key sayı (1-25)').setMinValue(1).setMaxValue(25).setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('İstifadəçini Whitelist-ə əlavə edir və avtomatik key yaradır')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((opt) => opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true))
      .addStringOption((opt) => opt.setName('duration').setDescription('Müddət').setRequired(true)),
    new SlashCommandBuilder()
      .setName('blacklist')
      .setDescription('İstifadəçini və ya HWID-i Blacklist-ə əlavə edir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((opt) => opt.setName('user').setDescription('Discord istifadəçisi').setRequired(false))
      .addStringOption((opt) => opt.setName('hwid').setDescription('HWID dəyəri').setRequired(false))
      .addStringOption((opt) => opt.setName('reason').setDescription('Səbəb').setRequired(false)),
    new SlashCommandBuilder()
      .setName('resethwid')
      .setDescription('Key-in HWID kilidini sıfırlayır')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((opt) => opt.setName('key').setDescription('Key kodu').setRequired(true))
  ].map((c) => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(token);
    if (store.guildConfig.guildId) {
      await rest.put(Routes.applicationGuildCommands(appId, store.guildConfig.guildId), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: commands });
    }
  } catch (err) {
    console.warn('[SLASH REGISTER WARNING]', err.message);
  }
};

discordClient.once('clientReady', async () => {
  botRuntimeState = {
    ready: true,
    username: discordClient.user.tag,
    userId: discordClient.user.id,
    avatarUrl: discordClient.user.displayAvatarURL({ extension: 'png', size: 128 }),
    guildsCount: discordClient.guilds.cache.size,
    lastError: '',
    lastReadyAt: nowMs()
  };

  const firstGuild = store.guildConfig.guildId
    ? discordClient.guilds.cache.get(store.guildConfig.guildId) || discordClient.guilds.cache.first()
    : discordClient.guilds.cache.first();

  if (firstGuild) {
    store.guildConfig.guildId = firstGuild.id;
    store.guildConfig.guildName = firstGuild.name;
    store.guildConfig.guildIconUrl = firstGuild.iconURL({ extension: 'png', size: 128 }) || '';
    await saveStore();
  }

  console.log(`[DISCORD BOT] Aktivdir: ${discordClient.user.tag} (${discordClient.user.id})`);
  await registerSlashCommands();
  await syncExistingDiscordPanels();
});

discordClient.on('error', (err) => {
  botRuntimeState = {
    ...botRuntimeState,
    lastError: err.message
  };
  console.error('[DISCORD CLIENT ERROR]', err.message);
});

discordClient.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const actor = interaction.user.globalName || interaction.user.username;

      if (cmd === 'panel') {
        const chosenChannel = interaction.options.getChannel('channel') || interaction.channel;
        const result = await sendPanelToChannel({
          channelId: chosenChannel.id,
          scriptId: store.guildConfig.activePanelScriptId,
          actorTag: actor
        });
        await interaction.reply({
          content: `✅ Panel **#${result.channelName}** kanalına göndərildi!`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmd === 'genkey') {
        const duration = interaction.options.getString('duration', true);
        const count = interaction.options.getInteger('count') || 1;
        const created = await createKeyBatch({
          scriptId: store.guildConfig.activePanelScriptId,
          durationKey: duration,
          count,
          createdByTag: actor
        });
        const listText = created.map((k) => `• \`${k.code}\` (${k.durationLabel})`).join('\n');
        await interaction.reply({
          content: `🔑 **${created.length} ədəd Key yaradıldı:**\n${listText}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmd === 'whitelist') {
        const targetUser = interaction.options.getUser('user', true);
        const duration = interaction.options.getString('duration', true);
        const wlRes = await addWhitelistRecord({
          discordId: targetUser.id,
          discordTag: targetUser.globalName || targetUser.username,
          avatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 128 }),
          durationKey: duration,
          scriptId: store.guildConfig.activePanelScriptId,
          actorTag: actor
        });
        await interaction.reply({
          content:
            `✅ **Whitelist & Auto Key Yaradıldı!**\n` +
            `• **İstifadəçi:** ${targetUser} (\`${targetUser.id}\`)\n` +
            `• **Müddət:** \`${wlRes.durationLabel}\`\n` +
            `• **Avto Key:** \`${wlRes.autoKeyCode}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmd === 'blacklist') {
        const targetUser = interaction.options.getUser('user');
        const hwid = interaction.options.getString('hwid') || '';
        const reason = interaction.options.getString('reason') || 'Discord komandası ilə əlavə edildi';
        const blRes = await addBlacklistRecord({
          discordId: targetUser ? targetUser.id : '',
          hwid,
          reason,
          actorTag: actor
        });
        await interaction.reply({
          content: `⛔ **Blacklist-ə əlavə edildi:** \`${blRes.discordTag}\` | Səbəb: \`${blRes.reason}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmd === 'resethwid') {
        const codeInput = String(interaction.options.getString('key', true)).trim().toUpperCase();
        const keyRecord = store.keys.find((k) => k.code.toUpperCase() === codeInput);
        if (!keyRecord) {
          await interaction.reply({ content: '❌ Key tapılmadı.', flags: MessageFlags.Ephemeral });
          return;
        }
        keyRecord.hwid = '';
        await saveStore();
        await appendAuditLog(actor, 'RESET_HWID', `Key=${keyRecord.code}`);
        await interaction.reply({
          content: `🔄 \`${keyRecord.code}\` key-inin HWID-si sıfırlandı.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isButton() && String(interaction.customId || '').startsWith('sp_action:')) {
      const parts = String(interaction.customId).split(':');
      const actionKey = parts[1] || 'get_script';
      const scriptId = parts[2] || store.guildConfig.activePanelScriptId;
      const scriptObj = store.scripts.find((s) => s.id === scriptId) || store.scripts[0];
      const baseUrl = getBasePublicUrl(null);

      if (isUserBlacklisted(interaction.user.id)) {
        await interaction.reply({
          content: '⛔ Siz **Blacklist**-dəsiniz. Sistemdən istifadə məhdudlaşdırılıb.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === 'get_script') {
        const userKey = store.keys.find(
          (k) =>
            k.scriptId === scriptObj.id &&
            k.status === 'active' &&
            !isItemExpired(k) &&
            (!k.usedById || k.usedById === interaction.user.id)
        );
        const wlRecord = getActiveWhitelistForUser(interaction.user.id, scriptObj.id);

        if (!userKey && !wlRecord) {
          await interaction.reply({
            content:
              '🔒 **Get Script** üçün aktiv key-iniz və ya Whitelist statusunuz olmalıdır.\nƏvvəlcə **Redeem Key** düyməsi ilə key aktivləşdirin.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const resolvedKey =
          (userKey && userKey.code) ||
          (wlRecord && wlRecord.autoKeyCode) ||
          'SADO-WL-ACCESS';

        const bundle = buildGetScriptBundle(scriptObj, baseUrl, {
          scriptKey: resolvedKey
        });

        const copyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`sp_copy_script:${scriptObj.id}:${encodeURIComponent(resolvedKey)}`)
            .setLabel('Scripti Kopyala')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Success)
        );

        await interaction.reply({
          content:
            `📜 **${scriptObj.name} — Script & Key (Birləşik)**\n` +
            `${bundle.copyBlock}\n` +
            `📋 Kopyalamaq üçün aşağıdakı **Scripti Kopyala** düyməsinə basın:`,
          components: [copyRow],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === 'redeem_key') {
        const modal = new ModalBuilder()
          .setCustomId(`sp_modal_redeem:${scriptObj.id}`)
          .setTitle('🔑 Key Aktivləşdirmə (Redeem)');

        const keyInput = new TextInputBuilder()
          .setCustomId('key_code_input')
          .setLabel('Script Key Kodunu Daxil Edin')
          .setPlaceholder('Məs: SADO-XXXX-XXXX-XXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const hwidInput = new TextInputBuilder()
          .setCustomId('hwid_input')
          .setLabel('HWID (İstəyə bağlı)')
          .setPlaceholder('Cihaz HWID-si')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(keyInput),
          new ActionRowBuilder().addComponents(hwidInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (actionKey === 'get_role') {
        const hasAccess =
          Boolean(getActiveWhitelistForUser(interaction.user.id, scriptObj.id)) ||
          store.keys.some(
            (k) => k.usedById === interaction.user.id && k.status === 'active' && !isItemExpired(k)
          );

        if (!hasAccess) {
          await interaction.reply({
            content: '❌ Rol almaq üçün aktiv key-iniz və ya Whitelist qeydiniz olmalıdır.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const roleId = String(store.guildConfig.buyerRoleId || '').trim();
        if (!roleId || !interaction.guild) {
          await interaction.reply({
            content: '⚠️ Buyer Role hələ konfiqurasiya edilməyib.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) {
          await interaction.reply({ content: '❌ Server üzvü tapılmadı.', flags: MessageFlags.Ephemeral });
          return;
        }

        await member.roles.add(roleId).catch(() => null);
        await interaction.reply({
          content: `🎭 <@&${roleId}> rolu uğurla verildi!`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === 'reset_hwid') {
        const userKeys = store.keys.filter((k) => k.usedById === interaction.user.id && k.status === 'active');
        if (userKeys.length === 0) {
          await interaction.reply({
            content: '❌ Sizə bağlı aktiv key tapılmadı.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        for (const k of userKeys) {
          k.hwid = '';
        }
        await saveStore();
        await appendAuditLog(
          interaction.user.globalName || interaction.user.username,
          'USER_RESET_HWID',
          `User=${interaction.user.id} | Keys=${userKeys.length}`
        );
        await interaction.reply({
          content: `🔄 **${userKeys.length}** ədəd key-inizin HWID kilidi sıfırlandı!`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isButton() && String(interaction.customId || '').startsWith('sp_copy_script:')) {
      const parts = String(interaction.customId).split(':');
      const scriptId = parts[1] || store.guildConfig.activePanelScriptId;
      const keyCode = decodeURIComponent(parts.slice(2).join(':') || 'SADO-KEY');
      const scriptObj = store.scripts.find((s) => s.id === scriptId) || store.scripts[0];
      const baseUrl = getBasePublicUrl(null);
      const bundle = buildGetScriptBundle(scriptObj, baseUrl, { scriptKey: keyCode });

      await interaction.reply({
        content:
          `📋 **Kopyalana Bilən Script (Basılı Saxlayıb Kopyalayın):**\n` +
          `${bundle.copyBlock}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isModalSubmit() && String(interaction.customId || '').startsWith('sp_modal_redeem:')) {
      const scriptId = String(interaction.customId).split(':')[1] || store.guildConfig.activePanelScriptId;
      const codeInput = String(interaction.fields.getTextInputValue('key_code_input') || '')
        .trim()
        .toUpperCase();
      const hwidInput = String(interaction.fields.getTextInputValue('hwid_input') || '').trim();

      if (isUserBlacklisted(interaction.user.id, hwidInput)) {
        await appendRedeemLog({
          userId: interaction.user.id,
          userTag: interaction.user.globalName || interaction.user.username,
          keyCode: codeInput,
          scriptName: scriptId,
          hwid: hwidInput,
          status: 'blocked',
          message: 'Blacklisted user/HWID'
        });
        await interaction.reply({ content: '⛔ Siz Blacklist-dəsiniz.', flags: MessageFlags.Ephemeral });
        return;
      }

      const keyObj = store.keys.find((k) => k.code.toUpperCase() === codeInput);
      if (!keyObj) {
        await appendRedeemLog({
          userId: interaction.user.id,
          userTag: interaction.user.globalName || interaction.user.username,
          keyCode: codeInput,
          scriptName: scriptId,
          hwid: hwidInput,
          status: 'failed',
          message: 'Key not found'
        });
        await interaction.reply({ content: '❌ Daxil edilən key tapılmadı.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (keyObj.status !== 'active' || isItemExpired(keyObj)) {
        await interaction.reply({
          content: '❌ Bu key aktiv deyil və ya müddəti bitib.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (keyObj.usedById && keyObj.usedById !== interaction.user.id) {
        await interaction.reply({
          content: '❌ Bu key başqa istifadəçiyə bağlıdır.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (hwidInput && keyObj.hwid && keyObj.hwid !== hwidInput) {
        await interaction.reply({
          content: '❌ Bu key başqa HWID-yə bağlıdır. Reset HWID istifadə edin.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      keyObj.usedById = interaction.user.id;
      keyObj.usedByTag = interaction.user.globalName || interaction.user.username;
      keyObj.usedByAvatar = interaction.user.displayAvatarURL({ extension: 'png', size: 128 });
      keyObj.redeemedAt = keyObj.redeemedAt || nowMs();
      if (hwidInput) {
        keyObj.hwid = hwidInput;
      }

      if (store.guildConfig.autoRoleOnRedeem && store.guildConfig.buyerRoleId && interaction.guild) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member) {
          await member.roles.add(store.guildConfig.buyerRoleId).catch(() => null);
        }
      }

      await saveStore();
      await appendRedeemLog({
        userId: interaction.user.id,
        userTag: keyObj.usedByTag,
        keyCode: keyObj.code,
        scriptName: keyObj.scriptName,
        hwid: keyObj.hwid,
        status: 'success',
        message: 'Redeemed successfully'
      });

      const targetScript = store.scripts.find((s) => s.id === keyObj.scriptId) || store.scripts[0];
      const bundle = buildGetScriptBundle(targetScript, getBasePublicUrl(null), { scriptKey: keyObj.code });

      await interaction.reply({
        content:
          `✅ **Key Aktivləşdirildi!**\n` +
          `• **Key:** \`${keyObj.code}\`\n` +
          `• **Müddət:** \`${keyObj.durationLabel}\`\n` +
          `${bundle.copyBlock}`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (err) {
    console.error('[INTERACTION ERROR]', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `⚠️ Xəta baş verdi: ${err.message}`,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

/* ============================================================================
 * 8. EXPRESS WEB SERVER, REST API & LOADER ENDPOINTS
 * ============================================================================ */

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    brand: APP_CONSTANTS.BRAND_NAME,
    botReady: botRuntimeState.ready,
    uptimeSec: Math.floor(process.uptime())
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    brand: APP_CONSTANTS.BRAND_NAME,
    botReady: botRuntimeState.ready,
    uptimeSec: Math.floor(process.uptime())
  });
});

app.get('/api/overview', async (req, res) => {
  try {
    const baseUrl = getBasePublicUrl(req);
    const activeScript =
      store.scripts.find((s) => s.id === store.guildConfig.activePanelScriptId) || store.scripts[0];

    let channels = [];
    let roles = [];

    if (discordClient.isReady()) {
      const targetGuild = store.guildConfig.guildId
        ? discordClient.guilds.cache.get(store.guildConfig.guildId) || discordClient.guilds.cache.first()
        : discordClient.guilds.cache.first();

      if (targetGuild) {
        store.guildConfig.guildId = targetGuild.id;
        store.guildConfig.guildName = targetGuild.name;
        store.guildConfig.guildIconUrl = targetGuild.iconURL({ extension: 'png', size: 128 }) || '';

        const fetchedChannels = await targetGuild.channels.fetch().catch(() => null);
        if (fetchedChannels) {
          channels = fetchedChannels
            .filter((ch) => ch && ch.type === ChannelType.GuildText)
            .map((ch) => ({ id: ch.id, name: ch.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        const fetchedRoles = await targetGuild.roles.fetch().catch(() => null);
        if (fetchedRoles) {
          roles = fetchedRoles
            .filter((r) => r && !r.managed && r.id !== targetGuild.id)
            .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
      }
    }

    const activeKeysCount = store.keys.filter((k) => k.status === 'active' && !isItemExpired(k)).length;
    const activeWhitelistCount = store.whitelist.filter((w) => !isItemExpired(w)).length;
    const activeBlacklistCount = store.blacklist.filter((b) => !isItemExpired(b)).length;

    const enrichedKeys = await Promise.all(
      store.keys.slice(0, 120).map(async (k) => {
        const expired = isItemExpired(k);
        const creatorProfile = k.createdById && !k.createdByAvatar ? await fetchDiscordUserProfile(k.createdById) : null;
        const userProfile = k.usedById && !k.usedByAvatar ? await fetchDiscordUserProfile(k.usedById) : null;
        return {
          ...k,
          isExpired: expired,
          effectiveStatus: expired && k.status === 'active' ? 'expired' : k.status,
          remainingLabel: formatRelativeRemaining(k.expiresAt),
          createdAtFormatted: formatDateTimeAz(k.createdAt),
          createdByTag: k.createdByTag || (creatorProfile ? creatorProfile.globalName : 'System'),
          createdByAvatar: k.createdByAvatar || (creatorProfile ? creatorProfile.avatarUrl : ''),
          usedByTag: k.usedByTag || (userProfile ? userProfile.globalName : k.usedById ? `User ${k.usedById}` : '—'),
          usedByAvatar: k.usedByAvatar || (userProfile ? userProfile.avatarUrl : '')
        };
      })
    );

    const enrichedWhitelist = await Promise.all(
      store.whitelist.slice(0, 120).map(async (w) => {
        const prof = !w.avatarUrl && w.discordId ? await fetchDiscordUserProfile(w.discordId) : null;
        return {
          ...w,
          isExpired: isItemExpired(w),
          remainingLabel: formatRelativeRemaining(w.expiresAt),
          createdAtFormatted: formatDateTimeAz(w.createdAt),
          discordTag: w.discordTag || (prof ? prof.globalName : w.discordId),
          avatarUrl: w.avatarUrl || (prof ? prof.avatarUrl : '')
        };
      })
    );

    const enrichedBlacklist = await Promise.all(
      store.blacklist.slice(0, 120).map(async (b) => {
        const prof = !b.avatarUrl && b.discordId ? await fetchDiscordUserProfile(b.discordId) : null;
        return {
          ...b,
          isExpired: isItemExpired(b),
          remainingLabel: formatRelativeRemaining(b.expiresAt),
          createdAtFormatted: formatDateTimeAz(b.createdAt),
          discordTag: b.discordTag || (prof ? prof.globalName : b.discordId || b.hwid),
          avatarUrl: b.avatarUrl || (prof ? prof.avatarUrl : '')
        };
      })
    );

    const sampleBundle = buildGetScriptBundle(activeScript, baseUrl);

    return res.json({
      ok: true,
      baseUrl,
      bot: {
        ...botRuntimeState,
        guildsCount: discordClient.isReady() ? discordClient.guilds.cache.size : 0
      },
      stats: {
        scriptsCount: store.scripts.length,
        activeKeysCount,
        totalKeysCount: store.keys.length,
        whitelistCount: activeWhitelistCount,
        blacklistCount: activeBlacklistCount,
        loaderRequests: Number(store.metrics.totalLoaderRequests) || 0,
        panelUpdatesCount: Number(store.metrics.panelUpdatesCount) || 0
      },
      guildConfig: store.guildConfig,
      panelDesign: store.panelDesign,
      channels,
      roles,
      scripts: store.scripts.map((s) => ({
        ...s,
        updatedAtFormatted: formatDateTimeAz(s.updatedAt),
        createdAtFormatted: formatDateTimeAz(s.createdAt)
      })),
      keys: enrichedKeys,
      whitelist: enrichedWhitelist,
      blacklist: enrichedBlacklist,
      auditLogs: store.auditLogs.slice(0, 80).map((l) => ({
        ...l,
        createdAtFormatted: formatDateTimeAz(l.createdAt)
      })),
      redeemLogs: store.redeemLogs.slice(0, 80).map((l) => ({
        ...l,
        createdAtFormatted: formatDateTimeAz(l.createdAt)
      })),
      executionLogs: store.executionLogs.slice(0, 80).map((l) => ({
        ...l,
        createdAtFormatted: formatDateTimeAz(l.createdAt)
      })),
      sampleBundle
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/guild/config', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.guildId !== undefined) store.guildConfig.guildId = String(body.guildId).trim();
    if (body.panelChannelId !== undefined) store.guildConfig.panelChannelId = String(body.panelChannelId).trim();
    if (body.logChannelId !== undefined) store.guildConfig.logChannelId = String(body.logChannelId).trim();
    if (body.buyerRoleId !== undefined) store.guildConfig.buyerRoleId = String(body.buyerRoleId).trim();
    if (body.activePanelScriptId !== undefined) store.guildConfig.activePanelScriptId = String(body.activePanelScriptId).trim();
    if (body.autoRoleOnRedeem !== undefined) store.guildConfig.autoRoleOnRedeem = Boolean(body.autoRoleOnRedeem);
    if (body.antiAltEnabled !== undefined) store.guildConfig.antiAltEnabled = Boolean(body.antiAltEnabled);
    if (body.requireKeyForLoader !== undefined) store.guildConfig.requireKeyForLoader = Boolean(body.requireKeyForLoader);
    store.guildConfig.updatedAt = nowMs();

    await saveStore();
    const syncedPanels = await syncExistingDiscordPanels();
    await appendAuditLog('Dashboard', 'UPDATE_GUILD_CONFIG', `Channel=${store.guildConfig.panelChannelId} | Synced=${syncedPanels}`);

    return res.json({ ok: true, guildConfig: store.guildConfig, syncedPanels });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/design', async (req, res) => {
  try {
    const body = req.body || {};
    store.panelDesign = {
      title: String(body.title || store.panelDesign.title).trim().slice(0, 256) || store.panelDesign.title,
      description:
        String(body.description || store.panelDesign.description).trim().slice(0, 4000) ||
        store.panelDesign.description,
      colorHex: sanitizeHexColor(body.colorHex, store.panelDesign.colorHex),
      footerText:
        String(body.footerText || store.panelDesign.footerText).trim().slice(0, 256) ||
        store.panelDesign.footerText,
      thumbnailUrl: body.thumbnailUrl !== undefined ? String(body.thumbnailUrl).trim() : store.panelDesign.thumbnailUrl,
      bannerUrl: body.bannerUrl !== undefined ? String(body.bannerUrl).trim() : store.panelDesign.bannerUrl,
      buttons: normalizePanelButtons(body.buttons || store.panelDesign.buttons),
      updatedAt: nowMs()
    };

    await saveStore();
    const syncedPanels = await syncExistingDiscordPanels();
    await appendAuditLog(
      'Dashboard',
      'UPDATE_PANEL_DESIGN',
      `Title="${store.panelDesign.title}" | Color=${store.panelDesign.colorHex} | SyncedPanels=${syncedPanels}`
    );

    return res.json({
      ok: true,
      panelDesign: store.panelDesign,
      syncedPanels
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/send', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sendPanelToChannel({
      channelId: body.channelId || store.guildConfig.panelChannelId,
      scriptId: body.scriptId || store.guildConfig.activePanelScriptId,
      actorTag: 'Dashboard'
    });
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/scripts/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || 'SADO Custom Script').trim().slice(0, 120) || 'SADO Custom Script';
    const version = String(body.version || '1.0.0').trim().slice(0, 32) || '1.0.0';
    const description = String(body.description || 'Dashboard generator vasitəsilə yaradıldı.').trim().slice(0, 500);
    const mode = String(body.mode || 'hub').trim();
    const obfuscationLevel = String(body.obfuscationLevel || 'Medium').trim();
    const hwidLock = body.hwidLock === false ? false : true;
    const keyRequired = body.keyRequired === false ? false : true;
    const antiDump = body.antiDump === false ? false : true;
    const antiHttpSpy = body.antiHttpSpy === false ? false : true;

    const rawLua =
      String(body.customLua || '').trim() ||
      buildProtectedLuaTemplate({
        scriptName: name,
        mode,
        antiDump,
        antiHttpSpy,
        hwidLock,
        keyCheck: keyRequired
      });

    const obfCode = obfuscateLuaSource(rawLua, obfuscationLevel);

    const newScript = {
      id: generateUniqueId('scr'),
      name,
      version,
      description,
      luaCode: rawLua,
      obfuscatedCode: obfCode,
      obfuscationLevel,
      hwidLock,
      keyRequired,
      active: true,
      executions: 0,
      createdAt: nowMs(),
      updatedAt: nowMs()
    };

    store.scripts.unshift(newScript);
    if (!store.guildConfig.activePanelScriptId) {
      store.guildConfig.activePanelScriptId = newScript.id;
    }

    await saveStore();
    await appendAuditLog('Dashboard', 'CREATE_SCRIPT', `Name=${newScript.name} | Mode=${mode} | Obf=${obfuscationLevel}`);

    return res.json({ ok: true, script: newScript });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/scripts/obfuscate', async (req, res) => {
  try {
    const body = req.body || {};
    const level = String(body.level || 'Ultra').trim();
    const targetId = String(body.scriptId || '').trim();
    const directCode = String(body.code || '').trim();

    if (targetId) {
      const found = store.scripts.find((s) => s.id === targetId);
      if (!found) {
        return res.status(404).json({ ok: false, error: 'Script tapılmadı.' });
      }
      const source = directCode || found.luaCode;
      found.luaCode = source;
      found.obfuscationLevel = level;
      found.obfuscatedCode = obfuscateLuaSource(source, level);
      found.updatedAt = nowMs();

      await saveStore();
      await appendAuditLog('Dashboard', 'OBFUSCATE_SCRIPT', `Script=${found.name} | Level=${level}`);
      return res.json({ ok: true, script: found, obfuscatedCode: found.obfuscatedCode });
    }

    if (!directCode) {
      return res.status(400).json({ ok: false, error: 'Obfuscate üçün Lua kodu və ya Script seçin.' });
    }

    const obfuscatedCode = obfuscateLuaSource(directCode, level);
    return res.json({ ok: true, obfuscatedCode, level });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/scripts/:id', async (req, res) => {
  try {
    const targetId = String(req.params.id || '').trim();
    if (store.scripts.length <= 1) {
      return res.status(400).json({ ok: false, error: 'Ən azı 1 script qalmalıdır.' });
    }
    const idx = store.scripts.findIndex((s) => s.id === targetId);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: 'Script tapılmadı.' });
    }
    const [removed] = store.scripts.splice(idx, 1);
    if (store.guildConfig.activePanelScriptId === targetId) {
      store.guildConfig.activePanelScriptId = store.scripts[0].id;
    }
    await saveStore();
    await appendAuditLog('Dashboard', 'DELETE_SCRIPT', `Name=${removed.name} (${removed.id})`);
    return res.json({ ok: true, deletedId: targetId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/scripts/:id/bundle', (req, res) => {
  try {
    const scriptObj = store.scripts.find((s) => s.id === req.params.id) || store.scripts[0];
    if (!scriptObj) {
      return res.status(404).json({ ok: false, error: 'Script tapılmadı.' });
    }
    const bundle = buildGetScriptBundle(scriptObj, getBasePublicUrl(req), {
      scriptKey: req.query.key || ''
    });
    return res.json({ ok: true, bundle });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/keys/create', async (req, res) => {
  try {
    const body = req.body || {};
    const created = await createKeyBatch({
      scriptId: body.scriptId || store.guildConfig.activePanelScriptId,
      durationKey: body.durationKey || 'lifetime',
      count: body.count || 1,
      prefix: body.prefix || APP_CONSTANTS.KEY_PREFIX,
      assignedUserId: body.assignedUserId || '',
      createdByTag: 'Dashboard'
    });
    return res.json({ ok: true, keys: created });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/keys/:id/reset-hwid', async (req, res) => {
  try {
    const keyObj = store.keys.find((k) => k.id === req.params.id);
    if (!keyObj) {
      return res.status(404).json({ ok: false, error: 'Key tapılmadı.' });
    }
    keyObj.hwid = '';
    await saveStore();
    await appendAuditLog('Dashboard', 'RESET_HWID', `Key=${keyObj.code}`);
    return res.json({ ok: true, key: keyObj });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/keys/:id/revoke', async (req, res) => {
  try {
    const keyObj = store.keys.find((k) => k.id === req.params.id);
    if (!keyObj) {
      return res.status(404).json({ ok: false, error: 'Key tapılmadı.' });
    }
    keyObj.status = keyObj.status === 'revoked' ? 'active' : 'revoked';
    await saveStore();
    await appendAuditLog('Dashboard', 'TOGGLE_KEY_STATUS', `Key=${keyObj.code} -> ${keyObj.status}`);
    return res.json({ ok: true, key: keyObj });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/keys/:id', async (req, res) => {
  try {
    const beforeLen = store.keys.length;
    store.keys = store.keys.filter((k) => k.id !== req.params.id);
    if (store.keys.length === beforeLen) {
      return res.status(404).json({ ok: false, error: 'Key tapılmadı.' });
    }
    await saveStore();
    await appendAuditLog('Dashboard', 'DELETE_KEY', `KeyId=${req.params.id}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/whitelist', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await addWhitelistRecord({
      discordId: body.discordId,
      discordTag: body.discordTag || '',
      avatarUrl: body.avatarUrl || '',
      durationKey: body.durationKey || 'lifetime',
      scriptId: body.scriptId || '',
      actorTag: 'Dashboard'
    });
    return res.json({ ok: true, whitelistEntry: result, autoKey: result.autoKey });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/whitelist/:id', async (req, res) => {
  try {
    const beforeLen = store.whitelist.length;
    store.whitelist = store.whitelist.filter((w) => w.id !== req.params.id);
    if (store.whitelist.length === beforeLen) {
      return res.status(404).json({ ok: false, error: 'Whitelist qeydi tapılmadı.' });
    }
    await saveStore();
    await appendAuditLog('Dashboard', 'WHITELIST_REMOVE', `Id=${req.params.id}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/blacklist', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await addBlacklistRecord({
      discordId: body.discordId || '',
      hwid: body.hwid || '',
      reason: body.reason || 'Dashboard tərəfindən əlavə edildi',
      durationKey: body.durationKey || 'lifetime',
      actorTag: 'Dashboard'
    });
    return res.json({ ok: true, blacklistEntry: result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/blacklist/:id', async (req, res) => {
  try {
    const beforeLen = store.blacklist.length;
    store.blacklist = store.blacklist.filter((b) => b.id !== req.params.id);
    if (store.blacklist.length === beforeLen) {
      return res.status(404).json({ ok: false, error: 'Blacklist qeydi tapılmadı.' });
    }
    await saveStore();
    await appendAuditLog('Dashboard', 'BLACKLIST_REMOVE', `Id=${req.params.id}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup', async (_req, res) => {
  const result = await createStoreBackupSnapshot('dashboard');
  if (!result.ok) {
    return res.status(500).json(result);
  }
  await appendAuditLog('Dashboard', 'BACKUP_CREATED', `File=${result.fileName}`);
  return res.json(result);
});

app.get('/api/loader/:scriptId', async (req, res) => {
  try {
    store.metrics.totalLoaderRequests = (Number(store.metrics.totalLoaderRequests) || 0) + 1;
    const scriptId = String(req.params.scriptId || '').trim();
    const keyParam = String(req.query.key || '').trim().toUpperCase();
    const hwidParam = String(req.query.hwid || req.headers['x-hwid'] || '').trim();
    const ipAddress = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

    const scriptObj = store.scripts.find((s) => s.id === scriptId) || store.scripts[0];
    if (!scriptObj || !scriptObj.active) {
      store.metrics.blockedRequests = (Number(store.metrics.blockedRequests) || 0) + 1;
      await saveStore();
      res.type('text/plain; charset=utf-8');
      return res.status(404).send(`-- [${APP_CONSTANTS.BRAND_NAME}] Script tapılmadı və ya deaktivdir.`);
    }

    const keyRecord = keyParam
      ? store.keys.find((k) => k.code.toUpperCase() === keyParam && k.scriptId === scriptObj.id) ||
        store.keys.find((k) => k.code.toUpperCase() === keyParam)
      : null;

    if (isUserBlacklisted(keyRecord?.usedById || '', hwidParam)) {
      store.metrics.blockedRequests = (Number(store.metrics.blockedRequests) || 0) + 1;
      await appendExecutionLog({
        scriptId: scriptObj.id,
        scriptName: scriptObj.name,
        keyCode: keyParam,
        hwid: hwidParam,
        ipAddress,
        allowed: false,
        reason: 'Blacklisted'
      });
      res.type('text/plain; charset=utf-8');
      return res.status(403).send(`-- [${APP_CONSTANTS.BRAND_NAME}] Access Denied: Blacklisted.`);
    }

    if (scriptObj.keyRequired || store.guildConfig.requireKeyForLoader) {
      if (!keyRecord || keyRecord.status !== 'active' || isItemExpired(keyRecord)) {
        store.metrics.blockedRequests = (Number(store.metrics.blockedRequests) || 0) + 1;
        await appendExecutionLog({
          scriptId: scriptObj.id,
          scriptName: scriptObj.name,
          keyCode: keyParam,
          hwid: hwidParam,
          ipAddress,
          allowed: false,
          reason: 'Invalid or expired key'
        });
        res.type('text/plain; charset=utf-8');
        return res.status(401).send(`-- [${APP_CONSTANTS.BRAND_NAME}] Etibarsız və ya vaxtı bitmiş key.`);
      }

      if (scriptObj.hwidLock && hwidParam) {
        if (!keyRecord.hwid) {
          keyRecord.hwid = hwidParam;
        } else if (keyRecord.hwid !== hwidParam) {
          store.metrics.blockedRequests = (Number(store.metrics.blockedRequests) || 0) + 1;
          await appendExecutionLog({
            scriptId: scriptObj.id,
            scriptName: scriptObj.name,
            keyCode: keyRecord.code,
            hwid: hwidParam,
            ipAddress,
            allowed: false,
            reason: 'HWID mismatch'
          });
          res.type('text/plain; charset=utf-8');
          return res.status(403).send(`-- [${APP_CONSTANTS.BRAND_NAME}] HWID uyğunsuzluğu.`);
        }
      }
    }

    scriptObj.executions = (Number(scriptObj.executions) || 0) + 1;
    scriptObj.updatedAt = nowMs();

    await appendExecutionLog({
      scriptId: scriptObj.id,
      scriptName: scriptObj.name,
      keyCode: keyRecord ? keyRecord.code : keyParam || 'PUBLIC',
      hwid: hwidParam || (keyRecord ? keyRecord.hwid : ''),
      ipAddress,
      allowed: true,
      reason: 'Delivered'
    });

    const payloadToServe =
      scriptObj.obfuscatedCode && scriptObj.obfuscationLevel !== 'None'
        ? scriptObj.obfuscatedCode
        : scriptObj.luaCode;

    res.type('text/plain; charset=utf-8');
    return res.status(200).send(payloadToServe);
  } catch (err) {
    res.type('text/plain; charset=utf-8');
    return res.status(500).send(`-- [${APP_CONSTANTS.BRAND_NAME}] Server Error: ${err.message}`);
  }
});

/* ============================================================================
 * 9. ANIMATED, ZERO-BLUE-TAP MODERN DASHBOARD HTML + CLIENT SCRIPT
 * ============================================================================ */

const DASHBOARD_HTML_LINES = [
  '<!DOCTYPE html>',
  '<html lang="az">',
  '<head>',
  '  <meta charset="UTF-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />',
  '  <title>SADO PROTECT — Cyber Command Dashboard</title>',
  '  <style>',
  '    :root {',
  '      --bg-main: #05070c;',
  '      --bg-surface: #0b0f19;',
  '      --bg-card: #101624;',
  '      --bg-card-hover: #161f33;',
  '      --border-subtle: rgba(255, 255, 255, 0.08);',
  '      --border-accent: rgba(245, 158, 11, 0.45);',
  '      --text-primary: #f8fafc;',
  '      --text-secondary: #94a3b8;',
  '      --text-muted: #64748b;',
  '      --accent: #f59e0b;',
  '      --accent-soft: rgba(245, 158, 11, 0.14);',
  '      --success: #10b981;',
  '      --danger: #ef4444;',
  '      --radius-lg: 18px;',
  '      --radius-md: 13px;',
  '      --radius-sm: 10px;',
  '      --ease-smooth: cubic-bezier(0.22, 1, 0.36, 1);',
  '    }',
  '',
  '    * {',
  '      box-sizing: border-box;',
  '      margin: 0;',
  '      padding: 0;',
  '      -webkit-tap-highlight-color: transparent;',
  '      -webkit-touch-callout: none;',
  '    }',
  '',
  '    html, body {',
  '      background-color: var(--bg-main);',
  '      color: var(--text-primary);',
  '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;',
  '      min-height: 100vh;',
  '      overflow-x: hidden;',
  '    }',
  '',
  '    button, input, select, textarea {',
  '      font-family: inherit;',
  '      -webkit-tap-highlight-color: transparent;',
  '      outline: none;',
  '    }',
  '',
  '    button:focus, button:active, a:focus, a:active {',
  '      background-color: inherit;',
  '      outline: none;',
  '    }',
  '',
  '    @keyframes fadeSlideUp {',
  '      from {',
  '        opacity: 0;',
  '        transform: translateY(12px) scale(0.99);',
  '      }',
  '      to {',
  '        opacity: 1;',
  '        transform: translateY(0) scale(1);',
  '      }',
  '    }',
  '',
  '    @keyframes drawerIn {',
  '      from {',
  '        opacity: 0;',
  '        transform: translateX(-18px);',
  '      }',
  '      to {',
  '        opacity: 1;',
  '        transform: translateX(0);',
  '      }',
  '    }',
  '',
  '    .topbar {',
  '      position: sticky;',
  '      top: 0;',
  '      z-index: 40;',
  '      display: flex;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      gap: 12px;',
  '      padding: 14px 18px;',
  '      background: rgba(11, 15, 25, 0.88);',
  '      backdrop-filter: blur(16px);',
  '      border-bottom: 1px solid var(--border-subtle);',
  '    }',
  '',
  '    .topbar-left {',
  '      display: flex;',
  '      align-items: center;',
  '      gap: 12px;',
  '      min-width: 0;',
  '    }',
  '',
  '    .menu-trigger {',
  '      width: 44px;',
  '      height: 44px;',
  '      border-radius: var(--radius-sm);',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      color: var(--text-primary);',
  '      font-size: 20px;',
  '      display: grid;',
  '      place-items: center;',
  '      cursor: pointer;',
  '      transition: transform 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth), background 0.2s var(--ease-smooth);',
  '    }',
  '',
  '    .menu-trigger:active {',
  '      transform: scale(0.93);',
  '      border-color: var(--accent);',
  '      background: var(--accent-soft);',
  '    }',
  '',
  '    .brand-title {',
  '      font-size: 16px;',
  '      font-weight: 800;',
  '      letter-spacing: 0.4px;',
  '      color: var(--accent);',
  '      white-space: nowrap;',
  '    }',
  '',
  '    .brand-sub {',
  '      font-size: 11px;',
  '      color: var(--text-secondary);',
  '      white-space: nowrap;',
  '      overflow: hidden;',
  '      text-overflow: ellipsis;',
  '    }',
  '',
  '    .bot-badge {',
  '      display: inline-flex;',
  '      align-items: center;',
  '      gap: 7px;',
  '      padding: 7px 12px;',
  '      border-radius: 999px;',
  '      font-size: 12px;',
  '      font-weight: 600;',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      white-space: nowrap;',
  '    }',
  '',
  '    .bot-dot {',
  '      width: 8px;',
  '      height: 8px;',
  '      border-radius: 50%;',
  '      background: var(--accent);',
  '    }',
  '',
  '    .bot-badge.online .bot-dot {',
  '      background: var(--success);',
  '      box-shadow: 0 0 10px rgba(16, 185, 129, 0.7);',
  '    }',
  '',
  '    .drawer-backdrop {',
  '      position: fixed;',
  '      inset: 0;',
  '      z-index: 80;',
  '      background: rgba(2, 4, 9, 0.72);',
  '      backdrop-filter: blur(6px);',
  '      opacity: 0;',
  '      pointer-events: none;',
  '      transition: opacity 0.26s var(--ease-smooth);',
  '    }',
  '',
  '    .drawer-backdrop.open {',
  '      opacity: 1;',
  '      pointer-events: auto;',
  '    }',
  '',
  '    .drawer-panel {',
  '      position: fixed;',
  '      top: 0;',
  '      left: 0;',
  '      bottom: 0;',
  '      z-index: 90;',
  '      width: min(350px, 88vw);',
  '      background: var(--bg-surface);',
  '      border-right: 1px solid var(--border-subtle);',
  '      padding: 20px 16px;',
  '      display: flex;',
  '      flex-direction: column;',
  '      gap: 12px;',
  '      overflow-y: auto;',
  '      transform: translateX(-100%);',
  '      transition: transform 0.3s var(--ease-smooth);',
  '    }',
  '',
  '    .drawer-panel.open {',
  '      transform: translateX(0);',
  '    }',
  '',
  '    .drawer-head {',
  '      display: flex;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      padding-bottom: 12px;',
  '      border-bottom: 1px solid var(--border-subtle);',
  '    }',
  '',
  '    .drawer-close {',
  '      width: 38px;',
  '      height: 38px;',
  '      border-radius: var(--radius-sm);',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      color: var(--text-primary);',
  '      font-size: 18px;',
  '      cursor: pointer;',
  '      transition: transform 0.18s var(--ease-smooth), border-color 0.18s var(--ease-smooth);',
  '    }',
  '',
  '    .drawer-close:active {',
  '      transform: scale(0.92);',
  '      border-color: var(--accent);',
  '    }',
  '',
  '    .nav-item-btn {',
  '      width: 100%;',
  '      text-align: left;',
  '      display: flex;',
  '      align-items: center;',
  '      gap: 12px;',
  '      padding: 14px 15px;',
  '      border-radius: var(--radius-md);',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      color: var(--text-primary);',
  '      font-size: 14px;',
  '      font-weight: 700;',
  '      cursor: pointer;',
  '      transition: transform 0.2s var(--ease-smooth), background 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth);',
  '    }',
  '',
  '    .nav-item-btn:hover {',
  '      background: var(--bg-card-hover);',
  '      border-color: rgba(245, 158, 11, 0.35);',
  '    }',
  '',
  '    .nav-item-btn:active {',
  '      transform: scale(0.97);',
  '    }',
  '',
  '    .nav-item-btn.active {',
  '      background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);',
  '      color: #090c12;',
  '      border-color: transparent;',
  '      box-shadow: 0 10px 24px rgba(245, 158, 11, 0.25);',
  '    }',
  '',
  '    .main-container {',
  '      max-width: 1120px;',
  '      margin: 0 auto;',
  '      padding: 20px 16px 64px;',
  '    }',
  '',
  '    .page-view {',
  '      display: none;',
  '      animation: fadeSlideUp 0.28s var(--ease-smooth) both;',
  '    }',
  '',
  '    .page-view.active {',
  '      display: block;',
  '    }',
  '',
  '    .page-header {',
  '      display: flex;',
  '      flex-wrap: wrap;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      gap: 12px;',
  '      margin-bottom: 18px;',
  '    }',
  '',
  '    .page-title {',
  '      font-size: 22px;',
  '      font-weight: 800;',
  '      letter-spacing: -0.2px;',
  '    }',
  '',
  '    .page-desc {',
  '      font-size: 13px;',
  '      color: var(--text-secondary);',
  '      margin-top: 3px;',
  '    }',
  '',
  '    .stats-grid {',
  '      display: grid;',
  '      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));',
  '      gap: 12px;',
  '      margin-bottom: 18px;',
  '    }',
  '',
  '    .stat-card {',
  '      background: var(--bg-card);',
  '      border: 1px solid var(--border-subtle);',
  '      border-radius: var(--radius-md);',
  '      padding: 16px;',
  '      transition: transform 0.22s var(--ease-smooth), border-color 0.22s var(--ease-smooth);',
  '    }',
  '',
  '    .stat-card:hover {',
  '      transform: translateY(-2px);',
  '      border-color: var(--border-accent);',
  '    }',
  '',
  '    .stat-label {',
  '      font-size: 12px;',
  '      color: var(--text-secondary);',
  '      margin-bottom: 6px;',
  '    }',
  '',
  '    .stat-value {',
  '      font-size: 24px;',
  '      font-weight: 800;',
  '      color: var(--accent);',
  '    }',
  '',
  '    .card {',
  '      background: var(--bg-card);',
  '      border: 1px solid var(--border-subtle);',
  '      border-radius: var(--radius-lg);',
  '      padding: 18px;',
  '      margin-bottom: 16px;',
  '    }',
  '',
  '    .card-title {',
  '      font-size: 16px;',
  '      font-weight: 700;',
  '      margin-bottom: 12px;',
  '    }',
  '',
  '    .form-grid {',
  '      display: grid;',
  '      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));',
  '      gap: 12px;',
  '      margin-bottom: 14px;',
  '    }',
  '',
  '    .field-group {',
  '      display: flex;',
  '      flex-direction: column;',
  '      gap: 6px;',
  '      margin-bottom: 12px;',
  '    }',
  '',
  '    .field-label {',
  '      font-size: 12px;',
  '      font-weight: 600;',
  '      color: var(--text-secondary);',
  '    }',
  '',
  '    .input, .select, .textarea {',
  '      width: 100%;',
  '      background: var(--bg-surface);',
  '      color: var(--text-primary);',
  '      border: 1px solid var(--border-subtle);',
  '      border-radius: var(--radius-sm);',
  '      padding: 11px 13px;',
  '      font-size: 14px;',
  '      transition: border-color 0.2s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth);',
  '    }',
  '',
  '    .input:focus, .select:focus, .textarea:focus {',
  '      border-color: var(--accent);',
  '      box-shadow: 0 0 0 3px var(--accent-soft);',
  '    }',
  '',
  '    .textarea {',
  '      min-height: 110px;',
  '      resize: vertical;',
  '    }',
  '',
  '    .code-box {',
  '      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;',
  '      font-size: 12.5px;',
  '      line-height: 1.55;',
  '      min-height: 160px;',
  '    }',
  '',
  '    .btn {',
  '      display: inline-flex;',
  '      align-items: center;',
  '      justify-content: center;',
  '      gap: 8px;',
  '      padding: 11px 16px;',
  '      border-radius: var(--radius-sm);',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-surface);',
  '      color: var(--text-primary);',
  '      font-size: 13.5px;',
  '      font-weight: 700;',
  '      cursor: pointer;',
  '      transition: transform 0.16s var(--ease-smooth), background 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth);',
  '    }',
  '',
  '    .btn:active {',
  '      transform: scale(0.96);',
  '    }',
  '',
  '    .btn-primary {',
  '      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);',
  '      color: #090c12;',
  '      border-color: transparent;',
  '    }',
  '',
  '    .btn-success {',
  '      background: rgba(16, 185, 129, 0.16);',
  '      color: #34d399;',
  '      border-color: rgba(16, 185, 129, 0.35);',
  '    }',
  '',
  '    .btn-danger {',
  '      background: rgba(239, 68, 68, 0.16);',
  '      color: #f87171;',
  '      border-color: rgba(239, 68, 68, 0.35);',
  '    }',
  '',
  '    .btn-sm {',
  '      padding: 7px 11px;',
  '      font-size: 12px;',
  '    }',
  '',
  '    .btn-row {',
  '      display: flex;',
  '      flex-wrap: wrap;',
  '      gap: 10px;',
  '      align-items: center;',
  '    }',
  '',
  '    .btn-order-item {',
  '      display: flex;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      gap: 10px;',
  '      padding: 12px 14px;',
  '      border-radius: var(--radius-md);',
  '      background: var(--bg-surface);',
  '      border: 1px solid var(--border-subtle);',
  '      margin-bottom: 10px;',
  '      transition: transform 0.18s var(--ease-smooth), border-color 0.18s var(--ease-smooth);',
  '    }',
  '',
  '    .btn-order-item:hover {',
  '      border-color: var(--border-accent);',
  '    }',
  '',
  '    .panel-preview-box {',
  '      border-radius: var(--radius-md);',
  '      background: #0d121d;',
  '      border: 1px solid var(--border-subtle);',
  '      border-left: 5px solid var(--accent);',
  '      padding: 16px;',
  '      transition: border-left-color 0.25s var(--ease-smooth);',
  '    }',
  '',
  '    .preview-btn-pill {',
  '      display: inline-flex;',
  '      align-items: center;',
  '      gap: 6px;',
  '      padding: 8px 14px;',
  '      border-radius: 8px;',
  '      font-size: 13px;',
  '      font-weight: 700;',
  '      background: rgba(255, 255, 255, 0.06);',
  '      border: 1px solid rgba(255, 255, 255, 0.12);',
  '      margin-right: 8px;',
  '      margin-top: 8px;',
  '    }',
  '',
  '    .list-stack {',
  '      display: flex;',
  '      flex-direction: column;',
  '      gap: 10px;',
  '    }',
  '',
  '    .list-row {',
  '      display: flex;',
  '      flex-wrap: wrap;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      gap: 12px;',
  '      padding: 13px 15px;',
  '      border-radius: var(--radius-md);',
  '      background: var(--bg-surface);',
  '      border: 1px solid var(--border-subtle);',
  '      transition: transform 0.18s var(--ease-smooth);',
  '    }',
  '',
  '    .list-row:hover {',
  '      transform: translateX(2px);',
  '    }',
  '',
  '    .pill {',
  '      display: inline-block;',
  '      padding: 3px 9px;',
  '      border-radius: 999px;',
  '      font-size: 11px;',
  '      font-weight: 700;',
  '      background: var(--accent-soft);',
  '      color: var(--accent);',
  '    }',
  '',
  '    .toast-banner {',
  '      position: fixed;',
  '      bottom: 20px;',
  '      left: 50%;',
  '      z-index: 120;',
  '      transform: translate(-50%, 24px);',
  '      opacity: 0;',
  '      pointer-events: none;',
  '      background: #141c2e;',
  '      color: var(--text-primary);',
  '      border: 1px solid var(--accent);',
  '      border-radius: var(--radius-md);',
  '      padding: 12px 18px;',
  '      font-size: 13.5px;',
  '      font-weight: 600;',
  '      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);',
  '      transition: opacity 0.24s var(--ease-smooth), transform 0.24s var(--ease-smooth);',
  '      max-width: 92vw;',
  '      text-align: center;',
  '    }',
  '',
  '    .toast-banner.show {',
  '      opacity: 1;',
  '      transform: translate(-50%, 0);',
  '    }',
  '',
  '    .check-inline {',
  '      display: inline-flex;',
  '      align-items: center;',
  '      gap: 8px;',
  '      font-size: 13px;',
  '      color: var(--text-secondary);',
  '      cursor: pointer;',
  '    }',
  '  </style>',
  '</head>',
  '<body>',
  '  <header class="topbar">',
  '    <div class="topbar-left">',
  '      <button type="button" id="openMenuBtn" class="menu-trigger" aria-label="Menyu">&#9776;</button>',
  '      <div>',
  '        <div class="brand-title">SADO PROTECT</div>',
  '        <div class="brand-sub" id="guildSubtitle">Cyber Command &bull; Loading...</div>',
  '      </div>',
  '    </div>',
  '    <div id="botStatusBadge" class="bot-badge">',
  '      <span class="bot-dot"></span>',
  '      <span id="botStatusText">Bot: Qoşulur...</span>',
  '    </div>',
  '  </header>',
  '',
  '  <div id="drawerBackdrop" class="drawer-backdrop"></div>',
  '  <aside id="drawerPanel" class="drawer-panel" aria-label="Bölmələr Menyusu">',
  '    <div class="drawer-head">',
  '      <div>',
  '        <div class="brand-title">SADO PROTECT</div>',
  '        <div class="brand-sub">Bölmə Seçin</div>',
  '      </div>',
  '      <button type="button" id="closeMenuBtn" class="drawer-close" aria-label="Bağla">&#10005;</button>',
  '    </div>',
  '    <button type="button" class="nav-item-btn active" data-page="overview"><span>&#128202;</span><span>1. Skriptlər, Keylər, Whitelist, Blacklist &amp; Sunucu</span></button>',
  '    <button type="button" class="nav-item-btn" data-page="generator"><span>&#9881;&#65039;</span><span>2. Script Yaratma &amp; Ultra Obfuscation</span></button>',
  '    <button type="button" class="nav-item-btn" data-page="access"><span>&#128273;</span><span>3. Key, Whitelist &amp; Blacklist</span></button>',
  '    <button type="button" class="nav-item-btn" data-page="panel_design"><span>&#127912;</span><span>4. Discord Bot &amp; Panel Dizayn</span></button>',
  '    <button type="button" class="nav-item-btn" data-page="send_panel"><span>&#128228;</span><span>5. Kanala Panel Göndər</span></button>',
  '  </aside>',
  '',
  '  <main class="main-container">',
  '    <!-- 1. OVERVIEW -->',
  '    <section id="page-overview" class="page-view active">',
  '      <div class="page-header">',
  '        <div>',
  '          <h1 class="page-title">Ümumi İdarəetmə &amp; Status</h1>',
  '          <p class="page-desc">Skriptlər, Keylər, Whitelist, Blacklist və Sunucu göstəriciləri</p>',
  '        </div>',
  '        <div class="btn-row">',
  '          <button type="button" id="refreshBtn" class="btn btn-sm">&#128260; Yenilə</button>',
  '          <button type="button" id="backupBtn" class="btn btn-sm btn-success">&#128190; Backup Al</button>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="stats-grid">',
  '        <div class="stat-card"><div class="stat-label">Aktiv Scriptlər</div><div class="stat-value" id="statScripts">0</div></div>',
  '        <div class="stat-card"><div class="stat-label">Aktiv Keylər</div><div class="stat-value" id="statKeys">0</div></div>',
  '        <div class="stat-card"><div class="stat-label">Whitelist</div><div class="stat-value" id="statWhitelist">0</div></div>',
  '        <div class="stat-card"><div class="stat-label">Blacklist</div><div class="stat-value" id="statBlacklist">0</div></div>',
  '        <div class="stat-card"><div class="stat-label">Loader Sorğusu</div><div class="stat-value" id="statLoaders">0</div></div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Birləşik Script &amp; Key Bundle (Get Script Preview)</div>',
  '        <div class="field-group">',
  '          <textarea id="bundlePreviewBox" class="textarea code-box" readonly></textarea>',
  '        </div>',
  '        <div class="btn-row">',
  '          <button type="button" id="copyBundleBtn" class="btn btn-primary">&#128203; Scripti Kopyala</button>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Son Audit Qeydləri</div>',
  '        <div id="auditLogsList" class="list-stack"></div>',
  '      </div>',
  '    </section>',
  '',
  '    <!-- 2. SCRIPT GENERATOR & OBFUSCATOR -->',
  '    <section id="page-generator" class="page-view">',
  '      <div class="page-header">',
  '        <div>',
  '          <h1 class="page-title">Script Yaratma &amp; Ultra Obfuscation</h1>',
  '          <p class="page-desc">Qorunan Lua script yaradın və Ultra səviyyədə obfuscate edin</p>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Yeni Script Yarat</div>',
  '        <div class="form-grid">',
  '          <div class="field-group">',
  '            <label class="field-label" for="genScriptName">Script Adı</label>',
  '            <input id="genScriptName" class="input" placeholder="Məs: SADO Hub v3" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="genScriptVersion">Versiya</label>',
  '            <input id="genScriptVersion" class="input" value="1.0.0" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="genScriptMode">Rejim</label>',
  '            <select id="genScriptMode" class="select">',
  '              <option value="hub">Hub Core</option>',
  '              <option value="combat">Combat Engine</option>',
  '              <option value="esp_radar">ESP &amp; Radar</option>',
  '              <option value="webhook_logger">Telemetry Logger</option>',
  '            </select>',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="genObfLevel">Obfuscation Səviyyəsi</label>',
  '            <select id="genObfLevel" class="select">',
  '              <option value="None">None</option>',
  '              <option value="Light">Light</option>',
  '              <option value="Medium" selected>Medium</option>',
  '              <option value="Ultra">Ultra</option>',
  '            </select>',
  '          </div>',
  '        </div>',
  '',
  '        <div class="btn-row" style="margin-bottom:14px;">',
  '          <label class="check-inline"><input type="checkbox" id="genHwidLock" checked /> HWID Lock</label>',
  '          <label class="check-inline"><input type="checkbox" id="genKeyRequired" checked /> Key Required</label>',
  '          <label class="check-inline"><input type="checkbox" id="genAntiDump" checked /> Anti-Dump</label>',
  '          <label class="check-inline"><input type="checkbox" id="genAntiHttpSpy" checked /> Anti-HttpSpy</label>',
  '        </div>',
  '',
  '        <div class="field-group">',
  '          <label class="field-label" for="genCustomLua">Xüsusi Lua Kodu (Boş qalsa avtomatik şablon yaradılır)</label>',
  '          <textarea id="genCustomLua" class="textarea code-box" placeholder="-- İstədiyiniz Lua kodunu yazın..."></textarea>',
  '        </div>',
  '',
  '        <div class="btn-row">',
  '          <button type="button" id="createScriptBtn" class="btn btn-primary">&#10024; Script Yarat və Saxla</button>',
  '          <button type="button" id="obfuscateDirectBtn" class="btn btn-success">&#128737;&#65039; Kodu Obfuscate Et</button>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Mövcud Scriptlər</div>',
  '        <div id="scriptsList" class="list-stack"></div>',
  '      </div>',
  '    </section>',
  '',
  '    <!-- 3. KEY, WHITELIST & BLACKLIST -->',
  '    <section id="page-access" class="page-view">',
  '      <div class="page-header">',
  '        <div>',
  '          <h1 class="page-title">Key, Whitelist &amp; Blacklist</h1>',
  '          <p class="page-desc">Whitelist əlavə edildikdə avtomatik key yaradılır və dərhal aktiv olur</p>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">&#128273; Key Yaratma</div>',
  '        <div class="form-grid">',
  '          <div class="field-group">',
  '            <label class="field-label" for="keyScriptSelect">Script</label>',
  '            <select id="keyScriptSelect" class="select"></select>',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="keyDurationSelect">Müddət</label>',
  '            <select id="keyDurationSelect" class="select">',
  '              <option value="1h">1 Saat</option>',
  '              <option value="1d">1 Gün</option>',
  '              <option value="7d">7 Gün</option>',
  '              <option value="30d">30 Gün</option>',
  '              <option value="lifetime" selected>Ömürlük (Lifetime)</option>',
  '            </select>',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="keyCountInput">Say</label>',
  '            <input id="keyCountInput" type="number" min="1" max="50" value="1" class="input" />',
  '          </div>',
  '        </div>',
  '        <button type="button" id="createKeysBtn" class="btn btn-primary">&#10133; Key Yarat</button>',
  '        <div id="keysList" class="list-stack" style="margin-top:14px;"></div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">&#9989; Whitelist (Avto Key Yaradılır)</div>',
  '        <div class="form-grid">',
  '          <div class="field-group">',
  '            <label class="field-label" for="wlDiscordIdInput">Discord ID</label>',
  '            <input id="wlDiscordIdInput" class="input" placeholder="123456789012345678" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="wlDurationSelect">Müddət</label>',
  '            <select id="wlDurationSelect" class="select">',
  '              <option value="1d">1 Gün</option>',
  '              <option value="7d">7 Gün</option>',
  '              <option value="30d">30 Gün</option>',
  '              <option value="lifetime" selected>Ömürlük (Lifetime)</option>',
  '            </select>',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="wlScriptSelect">Script (İstəyə bağlı)</label>',
  '            <select id="wlScriptSelect" class="select"></select>',
  '          </div>',
  '        </div>',
  '        <button type="button" id="addWhitelistBtn" class="btn btn-success">&#10133; Whitelist-ə Əlavə Et &amp; Key Yarat</button>',
  '        <div id="whitelistList" class="list-stack" style="margin-top:14px;"></div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">&#128683; Blacklist</div>',
  '        <div class="form-grid">',
  '          <div class="field-group">',
  '            <label class="field-label" for="blDiscordIdInput">Discord ID</label>',
  '            <input id="blDiscordIdInput" class="input" placeholder="123456789012345678" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="blHwidInput">HWID</label>',
  '            <input id="blHwidInput" class="input" placeholder="HWID dəyəri" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="blReasonInput">Səbəb</label>',
  '            <input id="blReasonInput" class="input" placeholder="Səbəb" />',
  '          </div>',
  '        </div>',
  '        <button type="button" id="addBlacklistBtn" class="btn btn-danger">&#128683; Blacklist-ə Əlavə Et</button>',
  '        <div id="blacklistList" class="list-stack" style="margin-top:14px;"></div>',
  '      </div>',
  '    </section>',
  '',
  '    <!-- 4. DISCORD BOT & PANEL DESIGN -->',
  '    <section id="page-panel_design" class="page-view">',
  '      <div class="page-header">',
  '        <div>',
  '          <h1 class="page-title">Discord Bot &amp; Panel Dizayn</h1>',
  '          <p class="page-desc">Yer dəyişmə, rəng və emoji dəyişdikdə mövcud Discord paneli avtomatik yenilənir</p>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Embed &amp; Rəng Ayarları</div>',
  '        <div class="form-grid">',
  '          <div class="field-group">',
  '            <label class="field-label" for="panelTitleInput">Panel Başlığı</label>',
  '            <input id="panelTitleInput" class="input" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="panelColorInput">Embed Rəngi (Hex)</label>',
  '            <input id="panelColorInput" type="color" class="input" style="height:44px;padding:4px;" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="panelFooterInput">Footer Mətni</label>',
  '            <input id="panelFooterInput" class="input" />',
  '          </div>',
  '        </div>',
  '        <div class="field-group">',
  '          <label class="field-label" for="panelDescInput">Panel Təsviri</label>',
  '          <textarea id="panelDescInput" class="textarea"></textarea>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Düymə Sırası, Emoji &amp; Adları</div>',
  '        <div id="panelButtonsOrderList"></div>',
  '        <div class="btn-row" style="margin-top:12px;">',
  '          <button type="button" id="savePanelDesignBtn" class="btn btn-primary">&#128190; Dizaynı Saxla və Paneli Canlı Yenilə</button>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Canlı Panel Önbaxışı</div>',
  '        <div id="livePanelPreview" class="panel-preview-box"></div>',
  '      </div>',
  '    </section>',
  '',
  '    <!-- 5. SEND PANEL TO CHANNEL -->',
  '    <section id="page-send_panel" class="page-view">',
  '      <div class="page-header">',
  '        <div>',
  '          <h1 class="page-title">Kanala Panel Göndər</h1>',
  '          <p class="page-desc">Discord kanalını və scripti seçib paneli göndərin</p>',
  '        </div>',
  '      </div>',
  '',
  '      <div class="card">',
  '        <div class="card-title">Panel Göndərmə Parametrləri</div>',
  '        <div class="form-grid">',
  '          <div class="field-group">',
  '            <label class="field-label" for="sendChannelSelect">Discord Kanalı</label>',
  '            <select id="sendChannelSelect" class="select"></select>',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="sendChannelManualId">Və ya Kanal ID-si</label>',
  '            <input id="sendChannelManualId" class="input" placeholder="123456789012345678" />',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="sendScriptSelect">Aktiv Script</label>',
  '            <select id="sendScriptSelect" class="select"></select>',
  '          </div>',
  '          <div class="field-group">',
  '            <label class="field-label" for="sendRoleSelect">Buyer Rolu</label>',
  '            <select id="sendRoleSelect" class="select"></select>',
  '          </div>',
  '        </div>',
  '        <div class="btn-row">',
  '          <button type="button" id="sendPanelNowBtn" class="btn btn-primary">&#128228; Kanala Panel Göndər</button>',
  '          <button type="button" id="syncPanelsNowBtn" class="btn btn-success">&#9889; Mövcud Panelləri Yenilə</button>',
  '        </div>',
  '      </div>',
  '    </section>',
  '  </main>',
  '',
  '  <div id="toastEl" class="toast-banner"></div>',
  '',
  '  <script>',
  '    (() => {',
  '      const uiState = {',
  '        activePage: "overview",',
  '        data: null,',
  '        panelDraft: null',
  '      };',
  '',
  '      const showToast = (msg) => {',
  '        const toastEl = document.getElementById("toastEl");',
  '        if (!toastEl) return;',
  '        toastEl.textContent = String(msg || "");',
  '        toastEl.classList.add("show");',
  '        clearTimeout(window.__sadoToastTimer);',
  '        window.__sadoToastTimer = setTimeout(() => {',
  '          toastEl.classList.remove("show");',
  '        }, 2800);',
  '      };',
  '',
  '      const copyToClipboard = async (text) => {',
  '        const cleanText = String(text || "");',
  '        if (!cleanText) return false;',
  '        try {',
  '          if (navigator.clipboard && navigator.clipboard.writeText) {',
  '            await navigator.clipboard.writeText(cleanText);',
  '            return true;',
  '          }',
  '        } catch {}',
  '        try {',
  '          const helperArea = document.createElement("textarea");',
  '          helperArea.value = cleanText;',
  '          helperArea.style.position = "fixed";',
  '          helperArea.style.opacity = "0";',
  '          document.body.appendChild(helperArea);',
  '          helperArea.focus();',
  '          helperArea.select();',
  '          const ok = document.execCommand("copy");',
  '          document.body.removeChild(helperArea);',
  '          return ok;',
  '        } catch {',
  '          return false;',
  '        }',
  '      };',
  '',
  '      const apiCall = async (url, options = {}) => {',
  '        const resp = await fetch(url, {',
  '          headers: { "Content-Type": "application/json", ...(options.headers || {}) },',
  '          ...options',
  '        });',
  '        const json = await resp.json().catch(() => ({}));',
  '        if (!resp.ok || json.ok === false) {',
  '          throw new Error(json.error || "Sorğu xətası");',
  '        }',
  '        return json;',
  '      };',
  '',
  '      const setDrawerState = (open) => {',
  '        const backdrop = document.getElementById("drawerBackdrop");',
  '        const panel = document.getElementById("drawerPanel");',
  '        if (!backdrop || !panel) return;',
  '        backdrop.classList.toggle("open", Boolean(open));',
  '        panel.classList.toggle("open", Boolean(open));',
  '      };',
  '',
  '      const switchPage = (pageKey) => {',
  '        const validPages = ["overview", "generator", "access", "panel_design", "send_panel"];',
  '        const targetKey = validPages.includes(pageKey) ? pageKey : "overview";',
  '        uiState.activePage = targetKey;',
  '',
  '        document.querySelectorAll(".page-view").forEach((sec) => {',
  '          sec.classList.toggle("active", sec.id === "page-" + targetKey);',
  '        });',
  '',
  '        document.querySelectorAll(".nav-item-btn").forEach((btn) => {',
  '          btn.classList.toggle("active", btn.getAttribute("data-page") === targetKey);',
  '        });',
  '',
  '        setDrawerState(false);',
  '        window.scrollTo({ top: 0, behavior: "smooth" });',
  '      };',
  '',
  '      const renderPanelButtonsEditor = () => {',
  '        const container = document.getElementById("panelButtonsOrderList");',
  '        if (!container || !uiState.panelDraft) return;',
  '',
  '        const buttons = uiState.panelDraft.buttons || [];',
  '        container.innerHTML = buttons',
  '          .map((btn, idx) => {',
  '            return (',
  '              "<div class=\\"btn-order-item\\">" +',
  '              "  <div style=\\"display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;\\">" +',
  '              "    <span class=\\"pill\\">#" + (idx + 1) + "</span>" +',
  '              "    <input class=\\"input\\" style=\\"width:74px;padding:7px 9px;\\" data-btn-emoji=\\"" + idx + "\\" value=\\"" + (btn.emoji || "") + "\\" />" +',
  '              "    <input class=\\"input\\" style=\\"width:170px;padding:7px 10px;\\" data-btn-label=\\"" + idx + "\\" value=\\"" + (btn.label || "") + "\\" />" +',
  '              "  </div>" +',
  '              "  <div class=\\"btn-row\\">" +',
  '              "    <button type=\\"button\\" class=\\"btn btn-sm\\" data-move-up=\\"" + idx + "\\">&#8593;</button>" +',
  '              "    <button type=\\"button\\" class=\\"btn btn-sm\\" data-move-down=\\"" + idx + "\\">&#8595;</button>" +',
  '              "  </div>" +',
  '              "</div>"',
  '            );',
  '          })',
  '          .join("");',
  '',
  '        container.querySelectorAll("[data-btn-emoji]").forEach((inp) => {',
  '          inp.addEventListener("input", (e) => {',
  '            const i = Number(e.target.getAttribute("data-btn-emoji"));',
  '            if (uiState.panelDraft.buttons[i]) {',
  '              uiState.panelDraft.buttons[i].emoji = e.target.value;',
  '              renderLivePanelPreview();',
  '            }',
  '          });',
  '        });',
  '',
  '        container.querySelectorAll("[data-btn-label]").forEach((inp) => {',
  '          inp.addEventListener("input", (e) => {',
  '            const i = Number(e.target.getAttribute("data-btn-label"));',
  '            if (uiState.panelDraft.buttons[i]) {',
  '              uiState.panelDraft.buttons[i].label = e.target.value;',
  '              renderLivePanelPreview();',
  '            }',
  '          });',
  '        });',
  '',
  '        container.querySelectorAll("[data-move-up]").forEach((btn) => {',
  '          btn.addEventListener("click", () => {',
  '            const i = Number(btn.getAttribute("data-move-up"));',
  '            if (i > 0) {',
  '              const arr = uiState.panelDraft.buttons;',
  '              const tmp = arr[i - 1];',
  '              arr[i - 1] = arr[i];',
  '              arr[i] = tmp;',
  '              renderPanelButtonsEditor();',
  '              renderLivePanelPreview();',
  '            }',
  '          });',
  '        });',
  '',
  '        container.querySelectorAll("[data-move-down]").forEach((btn) => {',
  '          btn.addEventListener("click", () => {',
  '            const i = Number(btn.getAttribute("data-move-down"));',
  '            const arr = uiState.panelDraft.buttons;',
  '            if (i < arr.length - 1) {',
  '              const tmp = arr[i + 1];',
  '              arr[i + 1] = arr[i];',
  '              arr[i] = tmp;',
  '              renderPanelButtonsEditor();',
  '              renderLivePanelPreview();',
  '            }',
  '          });',
  '        });',
  '      };',
  '',
  '      const renderLivePanelPreview = () => {',
  '        const box = document.getElementById("livePanelPreview");',
  '        if (!box || !uiState.panelDraft) return;',
  '        const colorVal = document.getElementById("panelColorInput")?.value || uiState.panelDraft.colorHex || "#f59e0b";',
  '        const titleVal = document.getElementById("panelTitleInput")?.value || uiState.panelDraft.title || "";',
  '        const descVal = document.getElementById("panelDescInput")?.value || uiState.panelDraft.description || "";',
  '        const footerVal = document.getElementById("panelFooterInput")?.value || uiState.panelDraft.footerText || "";',
  '        box.style.borderLeftColor = colorVal;',
  '        const btnsHtml = (uiState.panelDraft.buttons || [])',
  '          .map((b) => "<span class=\\"preview-btn-pill\\">" + (b.emoji ? b.emoji + " " : "") + (b.label || "") + "</span>")',
  '          .join("");',
  '        box.innerHTML =',
  '          "<div style=\\"font-weight:800;font-size:15px;margin-bottom:6px;\\">" + titleVal + "</div>" +',
  '          "<div style=\\"font-size:13px;color:#cbd5e1;white-space:pre-line;margin-bottom:10px;\\">" + descVal + "</div>" +',
  '          "<div>" + btnsHtml + "</div>" +',
  '          "<div style=\\"font-size:11px;color:#64748b;margin-top:12px;\\">" + footerVal + "</div>";',
  '      };',
  '',
  '      const renderAll = () => {',
  '        const d = uiState.data;',
  '        if (!d) return;',
  '',
  '        const botBadge = document.getElementById("botStatusBadge");',
  '        const botText = document.getElementById("botStatusText");',
  '        const guildSub = document.getElementById("guildSubtitle");',
  '',
  '        if (botBadge && botText) {',
  '          botBadge.classList.toggle("online", Boolean(d.bot?.ready));',
  '          botText.textContent = d.bot?.ready ? "Bot: Online (" + (d.bot.username || "Ready") + ")" : "Bot: Qoşulur...";',
  '        }',
  '        if (guildSub) {',
  '          guildSub.textContent = d.guildConfig?.guildName ? d.guildConfig.guildName + " • SADO PROTECT" : "Cyber Command • Ready";',
  '        }',
  '',
  '        document.getElementById("statScripts").textContent = String(d.stats?.scriptsCount ?? 0);',
  '        document.getElementById("statKeys").textContent = String(d.stats?.activeKeysCount ?? 0);',
  '        document.getElementById("statWhitelist").textContent = String(d.stats?.whitelistCount ?? 0);',
  '        document.getElementById("statBlacklist").textContent = String(d.stats?.blacklistCount ?? 0);',
  '        document.getElementById("statLoaders").textContent = String(d.stats?.loaderRequests ?? 0);',
  '',
  '        const bundleBox = document.getElementById("bundlePreviewBox");',
  '        if (bundleBox && d.sampleBundle) {',
  '          bundleBox.value = d.sampleBundle.combinedScript || "";',
  '        }',
  '',
  '        const scriptOpts = (d.scripts || [])',
  '          .map((s) => "<option value=\\"" + s.id + "\\">" + s.name + " (v" + s.version + ")</option>")',
  '          .join("");',
  '        const wlScriptOpts = "<option value=\\"\\">Bütün Scriptlər (ALL)</option>" + scriptOpts;',
  '',
  '        ["keyScriptSelect", "sendScriptSelect"].forEach((id) => {',
  '          const el = document.getElementById(id);',
  '          if (el) el.innerHTML = scriptOpts;',
  '        });',
  '        const wlSel = document.getElementById("wlScriptSelect");',
  '        if (wlSel) wlSel.innerHTML = wlScriptOpts;',
  '        if (d.guildConfig?.activePanelScriptId) {',
  '          const sendScriptEl = document.getElementById("sendScriptSelect");',
  '          if (sendScriptEl) sendScriptEl.value = d.guildConfig.activePanelScriptId;',
  '        }',
  '',
  '        const chSel = document.getElementById("sendChannelSelect");',
  '        if (chSel) {',
  '          chSel.innerHTML =',
  '            "<option value=\\"\\">Kanal seçin...</option>" +',
  '            (d.channels || []).map((c) => "<option value=\\"" + c.id + "\\">#" + c.name + "</option>").join("");',
  '          if (d.guildConfig?.panelChannelId) chSel.value = d.guildConfig.panelChannelId;',
  '        }',
  '',
  '        const roleSel = document.getElementById("sendRoleSelect");',
  '        if (roleSel) {',
  '          roleSel.innerHTML =',
  '            "<option value=\\"\\">Rol seçin...</option>" +',
  '            (d.roles || []).map((r) => "<option value=\\"" + r.id + "\\">@" + r.name + "</option>").join("");',
  '          if (d.guildConfig?.buyerRoleId) roleSel.value = d.guildConfig.buyerRoleId;',
  '        }',
  '',
  '        if (!uiState.panelDraft && d.panelDesign) {',
  '          uiState.panelDraft = JSON.parse(JSON.stringify(d.panelDesign));',
  '        }',
  '        if (uiState.panelDraft) {',
  '          const tIn = document.getElementById("panelTitleInput");',
  '          const cIn = document.getElementById("panelColorInput");',
  '          const fIn = document.getElementById("panelFooterInput");',
  '          const dIn = document.getElementById("panelDescInput");',
  '          if (tIn && document.activeElement !== tIn) tIn.value = uiState.panelDraft.title || "";',
  '          if (cIn && document.activeElement !== cIn) cIn.value = uiState.panelDraft.colorHex || "#f59e0b";',
  '          if (fIn && document.activeElement !== fIn) fIn.value = uiState.panelDraft.footerText || "";',
  '          if (dIn && document.activeElement !== dIn) dIn.value = uiState.panelDraft.description || "";',
  '          renderPanelButtonsEditor();',
  '          renderLivePanelPreview();',
  '        }',
  '',
  '        const scriptsList = document.getElementById("scriptsList");',
  '        if (scriptsList) {',
  '          scriptsList.innerHTML = (d.scripts || [])',
  '            .map((s) => {',
  '              return (',
  '                "<div class=\\"list-row\\">" +',
  '                "  <div>" +',
  '                "    <div style=\\"font-weight:700;\\">" + s.name + " <span class=\\"pill\\">v" + s.version + "</span> <span class=\\"pill\\">" + s.obfuscationLevel + "</span></div>" +',
  '                "    <div style=\\"font-size:12px;color:#94a3b8;margin-top:4px;\\">İcra: " + (s.executions || 0) + " • Yeniləndi: " + s.updatedAtFormatted + "</div>" +',
  '                "  </div>" +',
  '                "  <div class=\\"btn-row\\">" +',
  '                "    <button type=\\"button\\" class=\\"btn btn-sm btn-primary\\" data-copy-script=\\"" + s.id + "\\">&#128203; Scripti Kopyala</button>" +',
  '                "    <button type=\\"button\\" class=\\"btn btn-sm btn-danger\\" data-del-script=\\"" + s.id + "\\">Sil</button>" +',
  '                "  </div>" +',
  '                "</div>"',
  '              );',
  '            })',
  '            .join("");',
  '',
  '          scriptsList.querySelectorAll("[data-copy-script]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              const sid = btn.getAttribute("data-copy-script");',
  '              const res = await apiCall("/api/scripts/" + encodeURIComponent(sid) + "/bundle");',
  '              const ok = await copyToClipboard(res.bundle?.combinedScript || "");',
  '              showToast(ok ? "Script + Key kopyalandı!" : "Kopyalama uğursuz oldu.");',
  '            });',
  '          });',
  '',
  '          scriptsList.querySelectorAll("[data-del-script]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              try {',
  '                await apiCall("/api/scripts/" + encodeURIComponent(btn.getAttribute("data-del-script")), { method: "DELETE" });',
  '                showToast("Script silindi.");',
  '                await refreshData();',
  '              } catch (err) { showToast(err.message); }',
  '            });',
  '          });',
  '        }',
  '',
  '        const keysList = document.getElementById("keysList");',
  '        if (keysList) {',
  '          keysList.innerHTML = (d.keys || [])',
  '            .slice(0, 30)',
  '            .map((k) => {',
  '              return (',
  '                "<div class=\\"list-row\\">" +',
  '                "  <div>" +',
  '                "    <div style=\\"font-weight:700;font-family:monospace;\\">" + k.code + " <span class=\\"pill\\">" + k.effectiveStatus + "</span></div>" +',
  '                "    <div style=\\"font-size:12px;color:#94a3b8;margin-top:4px;\\">" + k.scriptName + " • " + k.durationLabel + " • Qalan: " + k.remainingLabel + "</div>" +',
  '                "  </div>" +',
  '                "  <div class=\\"btn-row\\">" +',
  '                "    <button type=\\"button\\" class=\\"btn btn-sm\\" data-copy-key=\\"" + k.code + "\\">Kopyala</button>" +',
  '                "    <button type=\\"button\\" class=\\"btn btn-sm btn-danger\\" data-del-key=\\"" + k.id + "\\">Sil</button>" +',
  '                "  </div>" +',
  '                "</div>"',
  '              );',
  '            })',
  '            .join("");',
  '',
  '          keysList.querySelectorAll("[data-copy-key]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              const ok = await copyToClipboard(btn.getAttribute("data-copy-key"));',
  '              showToast(ok ? "Key kopyalandı!" : "Kopyalanmadı.");',
  '            });',
  '          });',
  '',
  '          keysList.querySelectorAll("[data-del-key]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              await apiCall("/api/keys/" + encodeURIComponent(btn.getAttribute("data-del-key")), { method: "DELETE" });',
  '              showToast("Key silindi.");',
  '              await refreshData();',
  '            });',
  '          });',
  '        }',
  '',
  '        const wlList = document.getElementById("whitelistList");',
  '        if (wlList) {',
  '          wlList.innerHTML = (d.whitelist || [])',
  '            .map((w) => {',
  '              return (',
  '                "<div class=\\"list-row\\">" +',
  '                "  <div>" +',
  '                "    <div style=\\"font-weight:700;\\">" + w.discordTag + " <span class=\\"pill\\">" + w.discordId + "</span></div>" +',
  '                "    <div style=\\"font-size:12px;color:#34d399;margin-top:4px;font-family:monospace;\\">Auto Key: " + (w.autoKeyCode || "—") + " • " + w.durationLabel + "</div>" +',
  '                "  </div>" +',
  '                "  <div class=\\"btn-row\\">" +',
  '                (w.autoKeyCode ? "<button type=\\"button\\" class=\\"btn btn-sm\\" data-copy-wl-key=\\"" + w.autoKeyCode + "\\">Key Kopyala</button>" : "") +',
  '                "    <button type=\\"button\\" class=\\"btn btn-sm btn-danger\\" data-del-wl=\\"" + w.id + "\\">Sil</button>" +',
  '                "  </div>" +',
  '                "</div>"',
  '              );',
  '            })',
  '            .join("");',
  '',
  '          wlList.querySelectorAll("[data-copy-wl-key]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              const ok = await copyToClipboard(btn.getAttribute("data-copy-wl-key"));',
  '              showToast(ok ? "Avto Key kopyalandı!" : "Kopyalanmadı.");',
  '            });',
  '          });',
  '',
  '          wlList.querySelectorAll("[data-del-wl]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              await apiCall("/api/whitelist/" + encodeURIComponent(btn.getAttribute("data-del-wl")), { method: "DELETE" });',
  '              showToast("Whitelist-dən çıxarıldı.");',
  '              await refreshData();',
  '            });',
  '          });',
  '        }',
  '',
  '        const blList = document.getElementById("blacklistList");',
  '        if (blList) {',
  '          blList.innerHTML = (d.blacklist || [])',
  '            .map((b) => {',
  '              return (',
  '                "<div class=\\"list-row\\">" +',
  '                "  <div>" +',
  '                "    <div style=\\"font-weight:700;color:#f87171;\\">" + b.discordTag + "</div>" +',
  '                "    <div style=\\"font-size:12px;color:#94a3b8;margin-top:4px;\\">Səbəb: " + b.reason + " • " + b.createdAtFormatted + "</div>" +',
  '                "  </div>" +',
  '                "  <button type=\\"button\\" class=\\"btn btn-sm btn-danger\\" data-del-bl=\\"" + b.id + "\\">Sil</button>" +',
  '                "</div>"',
  '              );',
  '            })',
  '            .join("");',
  '',
  '          blList.querySelectorAll("[data-del-bl]").forEach((btn) => {',
  '            btn.addEventListener("click", async () => {',
  '              await apiCall("/api/blacklist/" + encodeURIComponent(btn.getAttribute("data-del-bl")), { method: "DELETE" });',
  '              showToast("Blacklist-dən çıxarıldı.");',
  '              await refreshData();',
  '            });',
  '          });',
  '        }',
  '',
  '        const auditEl = document.getElementById("auditLogsList");',
  '        if (auditEl) {',
  '          auditEl.innerHTML = (d.auditLogs || [])',
  '            .slice(0, 15)',
  '            .map((l) => {',
  '              return (',
  '                "<div class=\\"list-row\\">" +',
  '                "  <div>" +',
  '                "    <div style=\\"font-weight:700;\\"><span class=\\"pill\\">" + l.action + "</span> " + l.actor + "</div>" +',
  '                "    <div style=\\"font-size:12px;color:#94a3b8;margin-top:4px;\\">" + l.details + "</div>" +',
  '                "  </div>" +',
  '                "  <div style=\\"font-size:11px;color:#64748b;\\">" + l.createdAtFormatted + "</div>" +',
  '                "</div>"',
  '              );',
  '            })',
  '            .join("");',
  '        }',
  '      };',
  '',
  '      const refreshData = async () => {',
  '        try {',
  '          const json = await apiCall("/api/overview");',
  '          uiState.data = json;',
  '          renderAll();',
  '        } catch (err) {',
  '          showToast(err.message);',
  '        }',
  '      };',
  '',
  '      document.getElementById("openMenuBtn")?.addEventListener("click", () => setDrawerState(true));',
  '      document.getElementById("closeMenuBtn")?.addEventListener("click", () => setDrawerState(false));',
  '      document.getElementById("drawerBackdrop")?.addEventListener("click", () => setDrawerState(false));',
  '',
  '      document.querySelectorAll(".nav-item-btn").forEach((btn) => {',
  '        btn.addEventListener("click", () => {',
  '          const pageKey = btn.getAttribute("data-page");',
  '          switchPage(pageKey);',
  '        });',
  '      });',
  '',
  '      document.getElementById("refreshBtn")?.addEventListener("click", async () => {',
  '        await refreshData();',
  '        showToast("Məlumatlar yeniləndi.");',
  '      });',
  '',
  '      document.getElementById("backupBtn")?.addEventListener("click", async () => {',
  '        const res = await apiCall("/api/backup", { method: "POST" });',
  '        showToast("Backup yaradıldı: " + res.fileName);',
  '      });',
  '',
  '      document.getElementById("copyBundleBtn")?.addEventListener("click", async () => {',
  '        const val = document.getElementById("bundlePreviewBox")?.value || "";',
  '        const ok = await copyToClipboard(val);',
  '        showToast(ok ? "Script + Key kopyalandı!" : "Kopyalanmadı.");',
  '      });',
  '',
  '      document.getElementById("createScriptBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const payload = {',
  '            name: document.getElementById("genScriptName")?.value || "",',
  '            version: document.getElementById("genScriptVersion")?.value || "1.0.0",',
  '            mode: document.getElementById("genScriptMode")?.value || "hub",',
  '            obfuscationLevel: document.getElementById("genObfLevel")?.value || "Medium",',
  '            hwidLock: Boolean(document.getElementById("genHwidLock")?.checked),',
  '            keyRequired: Boolean(document.getElementById("genKeyRequired")?.checked),',
  '            antiDump: Boolean(document.getElementById("genAntiDump")?.checked),',
  '            antiHttpSpy: Boolean(document.getElementById("genAntiHttpSpy")?.checked),',
  '            customLua: document.getElementById("genCustomLua")?.value || ""',
  '          };',
  '          await apiCall("/api/scripts/generate", { method: "POST", body: JSON.stringify(payload) });',
  '          showToast("Yeni script yaradıldı!");',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      document.getElementById("obfuscateDirectBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const code = document.getElementById("genCustomLua")?.value || "";',
  '          const level = document.getElementById("genObfLevel")?.value || "Ultra";',
  '          const res = await apiCall("/api/scripts/obfuscate", { method: "POST", body: JSON.stringify({ code, level }) });',
  '          if (res.obfuscatedCode) {',
  '            document.getElementById("genCustomLua").value = res.obfuscatedCode;',
  '            showToast("Kod " + level + " səviyyəsində obfuscate olundu!");',
  '          }',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      document.getElementById("createKeysBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const payload = {',
  '            scriptId: document.getElementById("keyScriptSelect")?.value || "",',
  '            durationKey: document.getElementById("keyDurationSelect")?.value || "lifetime",',
  '            count: Number(document.getElementById("keyCountInput")?.value || 1)',
  '          };',
  '          const res = await apiCall("/api/keys/create", { method: "POST", body: JSON.stringify(payload) });',
  '          showToast((res.keys?.length || 1) + " ədəd key yaradıldı!");',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      document.getElementById("addWhitelistBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const payload = {',
  '            discordId: document.getElementById("wlDiscordIdInput")?.value || "",',
  '            durationKey: document.getElementById("wlDurationSelect")?.value || "lifetime",',
  '            scriptId: document.getElementById("wlScriptSelect")?.value || ""',
  '          };',
  '          const res = await apiCall("/api/whitelist", { method: "POST", body: JSON.stringify(payload) });',
  '          const autoCode = res.autoKey?.code || res.whitelistEntry?.autoKeyCode || "";',
  '          if (autoCode) {',
  '            await copyToClipboard(autoCode);',
  '          }',
  '          showToast("Whitelist-ə əlavə edildi & Auto Key yaradıldı: " + autoCode);',
  '          document.getElementById("wlDiscordIdInput").value = "";',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      document.getElementById("addBlacklistBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const payload = {',
  '            discordId: document.getElementById("blDiscordIdInput")?.value || "",',
  '            hwid: document.getElementById("blHwidInput")?.value || "",',
  '            reason: document.getElementById("blReasonInput")?.value || ""',
  '          };',
  '          await apiCall("/api/blacklist", { method: "POST", body: JSON.stringify(payload) });',
  '          showToast("Blacklist-ə əlavə edildi.");',
  '          document.getElementById("blDiscordIdInput").value = "";',
  '          document.getElementById("blHwidInput").value = "";',
  '          document.getElementById("blReasonInput").value = "";',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      ["panelTitleInput", "panelColorInput", "panelFooterInput", "panelDescInput"].forEach((id) => {',
  '        document.getElementById(id)?.addEventListener("input", () => {',
  '          if (!uiState.panelDraft) return;',
  '          uiState.panelDraft.title = document.getElementById("panelTitleInput")?.value || "";',
  '          uiState.panelDraft.colorHex = document.getElementById("panelColorInput")?.value || "#f59e0b";',
  '          uiState.panelDraft.footerText = document.getElementById("panelFooterInput")?.value || "";',
  '          uiState.panelDraft.description = document.getElementById("panelDescInput")?.value || "";',
  '          renderLivePanelPreview();',
  '        });',
  '      });',
  '',
  '      document.getElementById("savePanelDesignBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const payload = {',
  '            title: document.getElementById("panelTitleInput")?.value || "",',
  '            colorHex: document.getElementById("panelColorInput")?.value || "#f59e0b",',
  '            footerText: document.getElementById("panelFooterInput")?.value || "",',
  '            description: document.getElementById("panelDescInput")?.value || "",',
  '            buttons: uiState.panelDraft?.buttons || []',
  '          };',
  '          const res = await apiCall("/api/panel/design", { method: "POST", body: JSON.stringify(payload) });',
  '          uiState.panelDraft = res.panelDesign;',
  '          showToast("Panel dizaynı saxlandı və Discord paneli yeniləndi (" + (res.syncedPanels || 0) + ")!");',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      document.getElementById("sendPanelNowBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const manualId = document.getElementById("sendChannelManualId")?.value.trim();',
  '          const selId = document.getElementById("sendChannelSelect")?.value.trim();',
  '          const channelId = manualId || selId;',
  '          const scriptId = document.getElementById("sendScriptSelect")?.value || "";',
  '          const buyerRoleId = document.getElementById("sendRoleSelect")?.value || "";',
  '          await apiCall("/api/guild/config", { method: "POST", body: JSON.stringify({ panelChannelId: channelId, activePanelScriptId: scriptId, buyerRoleId }) });',
  '          const res = await apiCall("/api/panel/send", { method: "POST", body: JSON.stringify({ channelId, scriptId }) });',
  '          showToast("Panel #" + (res.result?.channelName || channelId) + " kanalına göndərildi!");',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      document.getElementById("syncPanelsNowBtn")?.addEventListener("click", async () => {',
  '        try {',
  '          const res = await apiCall("/api/panel/design", { method: "POST", body: JSON.stringify(uiState.panelDraft || {}) });',
  '          showToast("Mövcud panellər yeniləndi (" + (res.syncedPanels || 0) + ")!");',
  '          await refreshData();',
  '        } catch (err) { showToast(err.message); }',
  '      });',
  '',
  '      refreshData();',
  '      setInterval(refreshData, 15000);',
  '    })();',
  '  </script>',
  '</body>',
  '</html>'
];

const DASHBOARD_HTML = DASHBOARD_HTML_LINES.join('\n');

app.get('/', (_req, res) => {
  res.type('html; charset=utf-8').status(200).send(DASHBOARD_HTML);
});

/* ============================================================================
 * 10. SERVER & BOT BOOTSTRAP LIFECYCLE
 * ============================================================================ */

const startServerAndBot = async () => {
  try {
    await loadStore();

    const httpServer = http.createServer(app);
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(RUNTIME_ENV.port, '0.0.0.0', () => resolve());
    });

    console.log(`[HTTP SERVER] Port ${RUNTIME_ENV.port} üzərində işləyir.`);

    setInterval(async () => {
      await saveStore();
    }, APP_CONSTANTS.AUTO_SAVE_INTERVAL_MS);

    if (RUNTIME_ENV.discordToken) {
      await discordClient.login(RUNTIME_ENV.discordToken).catch((err) => {
        botRuntimeState = {
          ...botRuntimeState,
          ready: false,
          lastError: err.message
        };
        console.error('[DISCORD LOGIN ERROR]', err.message);
      });
    } else {
      console.warn('[DISCORD BOT] DISCORD_TOKEN mühit dəyişəni təyin olunmayıb; yalnız Web Dashboard aktivdir.');
    }
  } catch (err) {
    console.error('[FATAL STARTUP ERROR]', err.message);
    process.exit(1);
  }
};

startServerAndBot();
