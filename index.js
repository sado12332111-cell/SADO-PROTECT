const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:8080').replace(/\/$/, '');
const PORT = process.env.PORT || 8080;
const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });

const db = new Database(path.join(DIR, 'data.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS scripts(id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, name TEXT, code TEXT);
CREATE TABLE IF NOT EXISTS keys(key TEXT PRIMARY KEY, script_id INT, guild_id TEXT, max_users INT, role_id TEXT, days INT, created REAL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, lic TEXT UNIQUE, script_id INT, guild_id TEXT,
  user_id TEXT, name TEXT, avatar TEXT, hwid TEXT DEFAULT '', since REAL, expires REAL DEFAULT 0, runs INT DEFAULT 0,
  last_reset REAL DEFAULT 0, UNIQUE(key,user_id));
CREATE TABLE IF NOT EXISTS config(guild_id TEXT PRIMARY KEY, data TEXT);`);
const all = (s, ...a) => db.prepare(s).all(...a);
const get = (s, ...a) => db.prepare(s).get(...a);
const run = (s, ...a) => db.prepare(s).run(...a);

const DEFAULT = {
  title: 'Sado Panel', desc: 'Aşağıdakı düymələrdən istifadə et.', color: '5865F2',
  buttons: {
    redeem: { label: 'Redeem Key', emoji: '🔑', style: 'success', pos: 1 },
    script: { label: 'Get Script', emoji: '📜', style: 'primary', pos: 2 },
    stats: { label: 'Get Stats', emoji: '📊', style: 'secondary', pos: 3 },
    reset: { label: 'Reset HWID', emoji: '🔄', style: 'danger', pos: 4 },
  },
};
const STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
const cfg = (gid) => {
  const c = JSON.parse(JSON.stringify(DEFAULT));
  const r = get('SELECT data FROM config WHERE guild_id=?', gid);
  if (r) {
    const d = JSON.parse(r.data);
    for (const k of ['title', 'desc', 'color']) if (d[k]) c[k] = d[k];
    for (const b in d.buttons || {}) if (c.buttons[b]) Object.assign(c.buttons[b], d.buttons[b]);
  }
  return c;
};
const saveCfg = (gid, c) => run('INSERT OR REPLACE INTO config VALUES(?,?)', gid, JSON.stringify(c));
const now = () => Date.now() / 1000;
const mkkey = () => 'SADO-' + [1, 2, 3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
const mklic = () => 'LIC-' + crypto.randomBytes(10).toString('hex').toUpperCase();
const fmt = (t) => (t ? `<t:${Math.floor(t)}:R>` : 'Sonsuz');
const EPH = 64;

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const modal = (id, title, fields) => {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const [cid, label, o = {}] of fields) {
    const t = new TextInputBuilder().setCustomId(cid).setLabel(label)
      .setStyle(o.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(o.req !== false).setMaxLength(o.max || 100);
    if (o.v) t.setValue(String(o.v));
    m.addComponents(row(t));
  }
  return m;
};
const select = (id, ph, opts) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(ph)
  .addOptions(opts.map(([label, value]) => ({ label: String(label).slice(0, 100), value: String(value) })));

function panelRow(gid) {
  const c = cfg(gid);
  const btns = Object.entries(c.buttons).sort((a, b) => a[1].pos - b[1].pos).map(([id, b]) => {
    const x = new ButtonBuilder().setCustomId('p:' + id).setLabel(b.label).setStyle(STYLES[b.style] || ButtonStyle.Primary);
    if (b.emoji) try { x.setEmoji(b.emoji); } catch {}
    return x;
  });
  return row(...btns);
}

// ---------- redeem ----------
function redeem(gid, keystr, u) {
  const k = get('SELECT * FROM keys WHERE key=? AND guild_id=?', keystr.trim().toUpperCase(), gid);
  if (!k) return [null, '❌ Key tapılmadı.'];
  if (get('SELECT 1 x FROM users WHERE key=? AND user_id=?', k.key, u.id)) return [null, 'ℹ️ Bu keyi artıq sən işlətmisən.'];
  if (get('SELECT COUNT(*) c FROM users WHERE key=?', k.key).c >= k.max_users) return [null, '🚫 Bu keyi artıq başqası işlədib.'];
  const lic = mklic();
  run('INSERT INTO users(key,lic,script_id,guild_id,user_id,name,avatar,since,expires) VALUES(?,?,?,?,?,?,?,?,?)',
    k.key, lic, k.script_id, gid, u.id, u.displayName || u.username, u.displayAvatarURL(), now(), k.days ? now() + k.days * 86400 : 0);
  return [k, lic];
}
async function finishRedeem(i, keystr) {
  const [k, res] = redeem(i.guildId, keystr, i.member?.user ? Object.assign(i.user, { displayName: i.member.displayName }) : i.user);
  if (!k) { await i.reply({ content: res, flags: EPH }); return null; }
  if (k.role_id) i.member.roles.add(k.role_id).catch(() => {});
  const s = get('SELECT name FROM scripts WHERE id=?', k.script_id);
  const e = new EmbedBuilder().setTitle('✅ Key aktiv edildi').setColor(0x57f287).setThumbnail(i.user.displayAvatarURL())
    .addFields({ name: 'Script', value: s ? s.name : '?', inline: true }, { name: 'Lisenziya', value: '`' + res + '`', inline: true });
  await i.reply({ embeds: [e], flags: EPH });
  return k;
}

// ---------- user actions ----------
const acts = {
  script: (i, r) => i.reply({ content: `**${r.sname}**\n\`\`\`lua\nscript_key="${r.lic}"\nloadstring(game:HttpGet("${BASE}/l/${r.script_id}"))()\n\`\`\``, flags: EPH }),
  stats: (i, r) => i.reply({
    flags: EPH, embeds: [new EmbedBuilder().setTitle('📊 ' + r.sname).setColor(0x5865f2).setAuthor({ name: r.name, iconURL: r.avatar })
      .addFields({ name: 'Lisenziya', value: '`' + r.lic + '`' }, { name: 'HWID', value: r.hwid ? 'Bağlıdır ✅' : 'Boşdur', inline: true },
        { name: 'İşlədilmə', value: String(r.runs), inline: true }, { name: 'Başlama', value: fmt(r.since), inline: true },
        { name: 'Bitmə', value: fmt(r.expires), inline: true })],
  }),
  reset: (i, r) => {
    const left = r.last_reset + 86400 - now();
    if (left > 0) return i.reply({ content: `⏳ HWID reset üçün ${Math.floor(left / 3600)} saat ${Math.floor((left % 3600) / 60)} dəq gözlə.`, flags: EPH });
    run("UPDATE users SET hwid='', last_reset=? WHERE id=?", now(), r.id);
    return i.reply({ content: '✅ HWID sıfırlandı. Yeni cihazda işlədə bilərsən.', flags: EPH });
  },
};
const mine = (i) => all('SELECT u.*, s.name sname FROM users u JOIN scripts s ON s.id=u.script_id WHERE u.guild_id=? AND u.user_id=?', i.guildId, i.user.id);
async function askPick(i, action) {
  const rows = mine(i);
  if (!rows.length) return i.reply({ content: '❌ Səndə aktiv key yoxdur. Əvvəl **Redeem Key** et.', flags: EPH });
  if (rows.length === 1) return acts[action](i, rows[0]);
  return i.reply({ content: 'Script seç:', components: [row(select('s:pick:' + action, 'Script seç', rows.slice(0, 25).map((r) => [r.sname, r.id])))], flags: EPH });
}

// ---------- key generator state ----------
const kg = new Map();
const kgState = (uid) => { if (!kg.has(uid)) kg.set(uid, { script: null, count: 1, role: null, days: 0 }); return kg.get(uid); };
function makeKey(gid, s) {
  const key = mkkey();
  run('INSERT INTO keys VALUES(?,?,?,?,?,?,?)', key, s.script, gid, s.count, s.role, s.days, now());
  return key;
}

// ---------- client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const adminPerm = PermissionFlagsBits.ManageGuild;
const scriptOpt = (o) => o.setName('script').setDescription('Script').setRequired(true).setAutocomplete(true);
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Müştəri panelini göndər'),
  new SlashCommandBuilder().setName('admin').setDescription('İdarəetmə paneli'),
  new SlashCommandBuilder().setName('upload_script').setDescription('Fayldan script əlavə et')
    .addStringOption((o) => o.setName('name').setDescription('Ad').setRequired(true))
    .addAttachmentOption((o) => o.setName('file').setDescription('Script faylı').setRequired(true)),
  new SlashCommandBuilder().setName('whitelist').setDescription('İstifadəçini whitelist et')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)).addStringOption(scriptOpt)
    .addIntegerOption((o) => o.setName('days').setDescription('Gün (0 = sonsuz)')),
  new SlashCommandBuilder().setName('unwhitelist').setDescription('Whitelist-dən sil')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)).addStringOption(scriptOpt),
  new SlashCommandBuilder().setName('delete_script').setDescription('Script sil').addStringOption(scriptOpt),
].map((c) => c.setDefaultMemberPermissions(adminPerm).toJSON());

client.once('ready', async () => {
  await client.application.commands.set(commands);
  console.log('Bot hazırdır:', client.user.tag);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete()) {
      const f = i.options.getFocused();
      const r = all('SELECT id,name FROM scripts WHERE guild_id=? AND name LIKE ? LIMIT 25', i.guildId, `%${f}%`);
      return i.respond(r.map((x) => ({ name: x.name.slice(0, 100), value: String(x.id) })));
    }
    if (i.isChatInputCommand()) return await slash(i);
    if (i.isButton()) return await button(i);
    if (i.isStringSelectMenu() || i.isRoleSelectMenu()) return await menu(i);
    if (i.isModalSubmit()) return await modalSubmit(i);
  } catch (e) {
    console.error(e);
    if (i.isRepliable() && !i.replied && !i.deferred) i.reply({ content: '⚠️ Xəta baş verdi.', flags: EPH }).catch(() => {});
  }
});

async function slash(i) {
  const g = i.guildId;
  switch (i.commandName) {
    case 'panel': {
      const c = cfg(g);
      return i.reply({ embeds: [new EmbedBuilder().setTitle(c.title).setDescription(c.desc).setColor(parseInt(c.color, 16) || 0x5865f2)], components: [panelRow(g)] });
    }
    case 'admin': {
      const b = (id, l, s) => new ButtonBuilder().setCustomId(id).setLabel(l).setStyle(s);
      return i.reply({
        flags: EPH, embeds: [new EmbedBuilder().setTitle('🛠 Admin Panel').setDescription('Script, key və whitelist idarəsi.').setColor(0x5865f2)],
        components: [row(b('a:menu', '☰', ButtonStyle.Secondary), b('a:cs', '📝 Script yarat', ButtonStyle.Primary),
          b('a:ck', '🔑 Key yarat', ButtonStyle.Success), b('a:wl', '📋 Whitelist', ButtonStyle.Secondary))],
      });
    }
    case 'upload_script': {
      const code = await (await fetch(i.options.getAttachment('file').url)).text();
      run('INSERT INTO scripts(guild_id,name,code) VALUES(?,?,?)', g, i.options.getString('name'), code);
      return i.reply({ content: '✅ Script əlavə olundu.', flags: EPH });
    }
    case 'whitelist': {
      const u = i.options.getUser('user'), sid = i.options.getString('script'), d = i.options.getInteger('days') || 0;
      if (!get('SELECT 1 x FROM scripts WHERE id=? AND guild_id=?', sid, g)) return i.reply({ content: 'Script tapılmadı.', flags: EPH });
      const m = i.options.getMember('user');
      run('INSERT INTO users(key,lic,script_id,guild_id,user_id,name,avatar,since,expires) VALUES(?,?,?,?,?,?,?,?,?)',
        'WL-' + crypto.randomBytes(4).toString('hex'), mklic(), sid, g, u.id, m?.displayName || u.username, u.displayAvatarURL(), now(), d ? now() + d * 86400 : 0);
      return i.reply({ content: `✅ ${u} whitelist olundu. İndi \`/panel\` → Get Script.`, flags: EPH });
    }
    case 'unwhitelist':
      run('DELETE FROM users WHERE user_id=? AND script_id=? AND guild_id=?', i.options.getUser('user').id, i.options.getString('script'), g);
      return i.reply({ content: '✅ Silindi.', flags: EPH });
    case 'delete_script':
      run('DELETE FROM scripts WHERE id=? AND guild_id=?', i.options.getString('script'), g);
      return i.reply({ content: '🗑 Silindi.', flags: EPH });
  }
}

async function button(i) {
  const id = i.customId, g = i.guildId;
  if (id === 'p:redeem') return i.showModal(modal('m:redeem', 'Redeem Key', [['key', 'Key', {}]]));
  if (['p:script', 'p:stats', 'p:reset'].includes(id)) return askPick(i, id.slice(2));
  if (!i.memberPermissions.has(adminPerm) && !id.startsWith('c:')) return i.reply({ content: 'İcazən yoxdur.', flags: EPH });
  if (id === 'a:menu') {
    const o = Object.entries(DEFAULT.buttons).map(([k, v]) => [v.label, k]).concat([['Panel görünüşü (başlıq/rəng)', 'panel']]);
    return i.reply({ content: '🤖 **Bot ayarları**', components: [row(select('s:settings', 'Nəyi dəyişək?', o))], flags: EPH });
  }
  if (id === 'a:cs') return i.showModal(modal('m:cs', 'Script yarat', [['name', 'Script adı', { max: 50 }], ['code', 'Script kodu', { long: true, max: 4000 }]]));
  if (id === 'a:ck') {
    kg.delete(i.user.id);
    const sc = all('SELECT id,name FROM scripts WHERE guild_id=? LIMIT 25', g);
    if (!sc.length) return i.reply({ content: 'Əvvəl script yarat.', flags: EPH });
    return i.reply({
      content: 'Key ayarları:', flags: EPH, components: [
        row(select('s:kg:script', 'Script seç', sc.map((s) => [s.name, s.id]))),
        row(select('s:kg:count', 'Neçə nəfərlik? (1)', [1, 2, 3, 4, 5, 10].map((n) => [n + ' nəfərlik', n]))),
        row(new RoleSelectMenuBuilder().setCustomId('s:kg:role').setPlaceholder('Rol seç (istəyə bağlı)').setMinValues(0).setMaxValues(1)),
        row(select('s:kg:days', 'Müddət (Sonsuz)', [['Sonsuz', 0], ['1 gün', 1], ['7 gün', 7], ['30 gün', 30]])),
        row(new ButtonBuilder().setCustomId('b:kg:create').setLabel('🔑 Key yarat').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('b:kg:drop').setLabel('🎁 Key drop').setStyle(ButtonStyle.Primary)),
      ],
    });
  }
  if (id === 'a:wl') {
    const rows = all('SELECT u.*, s.name sname FROM users u JOIN scripts s ON s.id=u.script_id WHERE u.guild_id=? ORDER BY u.id DESC LIMIT 10', g);
    if (!rows.length) return i.reply({ content: 'Whitelist boşdur.', flags: EPH });
    return i.reply({
      flags: EPH, embeds: rows.map((r) => new EmbedBuilder().setColor(0x5865f2).setAuthor({ name: r.name, iconURL: r.avatar })
        .setDescription(`**${r.sname}**\nBitmə: ${fmt(r.expires)}\nHWID: ${r.hwid ? '✅' : '❌'}`)),
    });
  }
  if (id === 'b:kg:create' || id === 'b:kg:drop') {
    const s = kgState(i.user.id);
    if (!s.script) return i.reply({ content: 'Əvvəl script seç.', flags: EPH });
    const key = makeKey(g, s);
    if (id === 'b:kg:create') return i.reply({ content: `✅ Key: \`${key}\` (${s.count} nəfərlik)`, flags: EPH });
    await i.channel.send({
      embeds: [new EmbedBuilder().setTitle('🎁 Key Drop!').setColor(0xfee75c).setDescription(`${s.count} nəfərlik key. Kim tez götürsə onundur!`)],
      components: [row(new ButtonBuilder().setCustomId('c:claim:' + key).setLabel('🎁 Götür').setStyle(ButtonStyle.Success))],
    });
    return i.reply({ content: '✅ Drop göndərildi.', flags: EPH });
  }
  if (id.startsWith('c:claim:')) {
    const key = id.slice(8);
    const k = await finishRedeem(i, key);
    if (k && get('SELECT COUNT(*) c FROM users WHERE key=?', key).c >= k.max_users)
      i.message.edit({ embeds: [new EmbedBuilder().setTitle('🎁 Key götürüldü').setColor(0x747f8d).setDescription(`${i.user} götürdü.`).setThumbnail(i.user.displayAvatarURL())], components: [] }).catch(() => {});
  }
}

async function menu(i) {
  const [, kind, arg] = i.customId.split(':'), v = i.values;
  if (kind === 'pick') return acts[arg](i, mine(i).find((r) => String(r.id) === v[0]));
  if (kind === 'kg') {
    const s = kgState(i.user.id);
    if (arg === 'script') s.script = Number(v[0]);
    if (arg === 'count') s.count = Number(v[0]);
    if (arg === 'role') s.role = v[0] || null;
    if (arg === 'days') s.days = Number(v[0]);
    return i.deferUpdate();
  }
  if (kind === 'settings') {
    const c = cfg(i.guildId);
    if (v[0] === 'panel') return i.showModal(modal('m:panel', 'Panel görünüşü', [
      ['t', 'Başlıq', { v: c.title }], ['d', 'Təsvir', { long: true, max: 500, v: c.desc }], ['c', 'Rəng (hex)', { max: 7, v: c.color }]]));
    const b = c.buttons[v[0]];
    return i.showModal(modal('m:btn:' + v[0], 'Düymə: ' + v[0], [
      ['l', 'Ad', { max: 40, v: b.label }], ['e', 'Emoji', { req: false, v: b.emoji }],
      ['s', 'primary/secondary/success/danger', { max: 10, v: b.style }], ['p', 'Yer (1-4)', { max: 1, v: b.pos }]]));
  }
}

async function modalSubmit(i) {
  const f = (n) => i.fields.getTextInputValue(n), g = i.guildId;
  if (i.customId === 'm:redeem') return finishRedeem(i, f('key'));
  if (i.customId === 'm:cs') {
    run('INSERT INTO scripts(guild_id,name,code) VALUES(?,?,?)', g, f('name'), f('code'));
    return i.reply({ content: `✅ **${f('name')}** yaradıldı.`, flags: EPH });
  }
  const c = cfg(g);
  if (i.customId === 'm:panel') Object.assign(c, { title: f('t'), desc: f('d'), color: f('c').replace('#', '') });
  else {
    const b = c.buttons[i.customId.split(':')[2]];
    b.label = f('l'); b.emoji = f('e');
    if (STYLES[f('s')]) b.style = f('s');
    if (/^\d$/.test(f('p'))) b.pos = Number(f('p'));
  }
  saveCfg(g, c);
  return i.reply({ content: '✅ Yadda saxlandı. `/panel`-i yenidən göndər.', flags: EPH });
}

// ---------- HTTP: site + loader API ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, r) => r.send('ok'));
app.get('/api/stats', (_, r) => r.json({
  scripts: get('SELECT COUNT(*) c FROM scripts').c, users: get('SELECT COUNT(*) c FROM users').c,
  runs: get('SELECT COALESCE(SUM(runs),0) c FROM users').c, servers: client.guilds?.cache.size || 0,
}));
app.get('/l/:sid', (req, res) => res.type('text/plain').send(
  `local k = script_key
local ok, res = pcall(function()
    local h = game:GetService("RbxAnalyticsService"):GetClientId()
    return game:HttpGet("${BASE}/load?s=${req.params.sid.replace(/\D/g, '')}&k=" .. tostring(k) .. "&h=" .. h)
end)
if ok then loadstring(res)() else game.Players.LocalPlayer:Kick("Server xətası") end`));
const kick = (res, m) => res.type('text/plain').send(`game.Players.LocalPlayer:Kick("${m}")`);
app.get('/load', (req, res) => {
  const { s, k, h } = req.query;
  const r = get('SELECT * FROM users WHERE lic=? AND script_id=?', String(k), String(s));
  if (!r || !h) return kick(res, 'Yanlış key');
  if (r.expires && r.expires < now()) return kick(res, 'Key müddəti bitib');
  if (!r.hwid) run('UPDATE users SET hwid=? WHERE id=?', String(h), r.id);
  else if (r.hwid !== h) return kick(res, 'Bu key başqa cihaza bağlıdır');
  const sc = get('SELECT code FROM scripts WHERE id=?', s);
  if (!sc) return kick(res, 'Script tapılmadı');
  run('UPDATE users SET runs=runs+1 WHERE id=?', r.id);
  res.type('text/plain').send(sc.code);
});
app.listen(PORT, () => console.log('Sayt/API port:', PORT));
client.login(TOKEN);
