/* =========================================================
 * 微信端转盘抽奖系统 · 后端服务
 * 架构：Express + SQLite (better-sqlite3)
 * 防作弊：中奖概率算法完全在服务端执行（crypto 安全随机数），
 *         前端仅接收结果做动画展示。
 * ========================================================= */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
for (const d of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lottery.db'));
db.pragma('journal_mode = WAL');

/* ---------------- 数据库初始化 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '幸运大转盘抽奖',
  description TEXT DEFAULT '',
  rules TEXT DEFAULT '',
  images TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT,
  draft TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  prob_num INTEGER NOT NULL DEFAULT 1,
  prob_den INTEGER NOT NULL DEFAULT 100,
  is_blank INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  phone TEXT NOT NULL,
  scanned_at TEXT DEFAULT (datetime('now','localtime')),
  user_agent TEXT DEFAULT '',
  referer TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  drew_at TEXT,
  prize_id INTEGER,
  prize_name TEXT,
  prize_amount REAL DEFAULT 0,
  is_winner INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS duplicate_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  nickname TEXT DEFAULT '',
  phone TEXT NOT NULL,
  attempted_at TEXT DEFAULT (datetime('now','localtime')),
  user_agent TEXT DEFAULT '',
  ip TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_part_phone ON participants(activity_id, phone);
CREATE INDEX IF NOT EXISTS idx_part_scan ON participants(scanned_at);
CREATE INDEX IF NOT EXISTS idx_dup_phone ON duplicate_attempts(activity_id, phone);
`);

/* ---------------- 工具函数 ---------------- */
function scryptHash(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function nowLocal() {
  return new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
}
const PHONE_RE = /^1[3-9]\d{9}$/;

/* 默认奖品与概率（后台可随时修改） */
const DEFAULT_PRIZES = [
  { name: '100元现金', amount: 100, prob_num: 1, prob_den: 1000000, is_blank: 0 },
  { name: '50元现金',  amount: 50,  prob_num: 1, prob_den: 500000,  is_blank: 0 },
  { name: '20元现金',  amount: 20,  prob_num: 1, prob_den: 200000,  is_blank: 0 },
  { name: '10元现金',  amount: 10,  prob_num: 1, prob_den: 100000,  is_blank: 0 },
  { name: '5元现金',   amount: 5,   prob_num: 1, prob_den: 50000,   is_blank: 0 },
  { name: '2元现金',   amount: 2,   prob_num: 1, prob_den: 2000,    is_blank: 0 },
  { name: '1元现金',   amount: 1,   prob_num: 1, prob_den: 100,     is_blank: 0 },
  { name: '0.5元现金', amount: 0.5, prob_num: 1, prob_den: 20,      is_blank: 0 },
  { name: '谢谢惠顾',  amount: 0,   prob_num: 1, prob_den: 10,      is_blank: 1 }
];

/* ---------------- 初始数据种子 ---------------- */
if (!db.prepare('SELECT COUNT(*) c FROM admins').get().c) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admins(username,password_salt,password_hash) VALUES(?,?,?)')
    .run('admin', salt, scryptHash('admin123', salt));
  console.log('[init] 已创建默认管理员账号：admin / admin123（请登录后尽快修改密码）');
}
if (!db.prepare('SELECT COUNT(*) c FROM activities').get().c) {
  const info = db.prepare(
    `INSERT INTO activities(title,description,rules,status,published_at) VALUES(?,?,?,?,datetime('now','localtime'))`
  ).run(
    '幸运大转盘 · 扫码抽奖',
    '扫码参与幸运大转盘抽奖，现金好礼等你拿！',
    '1. 微信扫码进入活动页；\n2. 授权微信昵称并确认手机号；\n3. 每个手机号仅限参与 1 次抽奖；\n4. 中奖后凭手机号核销领奖。',
    'published'
  );
  const ins = db.prepare('INSERT INTO prizes(activity_id,name,amount,prob_num,prob_den,is_blank,sort) VALUES(?,?,?,?,?,?,?)');
  DEFAULT_PRIZES.forEach((p, i) => ins.run(info.lastInsertRowid, p.name, p.amount, p.prob_num, p.prob_den, p.is_blank, i));
  console.log(`[init] 已创建演示活动（ID=${info.lastInsertRowid}，已发布）`);
}

const app = express();
app.use(express.json({ limit: '12mb' }));

/* ---------------- 管理员鉴权 ---------------- */
function getAdmin(req) {
  let token = null;
  const ck = req.headers.cookie;
  if (ck) {
    const m = /(?:^|;\s*)token=([^;]+)/.exec(ck);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token && req.query.token) token = req.query.token;
  if (!token) return null;
  return db.prepare(
    `SELECT a.id, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > datetime('now','localtime')`
  ).get(token) || null;
}
function requireAdmin(req, res, next) {
  const a = getAdmin(req);
  if (!a) return res.status(401).json({ error: '未登录或登录已过期' });
  req.admin = a;
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(String(username || '').trim());
  if (!admin || scryptHash(String(password || ''), admin.password_salt) !== admin.password_hash) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO admin_sessions(token, admin_id, expires_at) VALUES(?,?,datetime('now','localtime','+2 days'))`)
    .run(token, admin.id);
  res.setHeader('Set-Cookie', `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=172800`);
  res.json({ token, username: admin.username });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  let token = null;
  const m = /(?:^|;\s*)token=([^;]+)/.exec(req.headers.cookie || '');
  if (m) token = decodeURIComponent(m[1]);
  if (!token && req.query.token) token = req.query.token;
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token=?').run(token);
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.admin.username }));
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id);
  if (scryptHash(String(oldPassword || ''), admin.password_salt) !== admin.password_hash) {
    return res.status(400).json({ error: '原密码错误' });
  }
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET password_salt=?, password_hash=? WHERE id=?')
    .run(salt, scryptHash(String(newPassword), salt), admin.id);
  res.json({ ok: true });
});

/* ---------------- 活动管理（管理后台） ---------------- */
function activityLink(req, id) {
  return `${req.protocol}://${req.get('host')}/h5/?a=${id}`;
}
function getActivity(id) {
  return db.prepare('SELECT * FROM activities WHERE id=?').get(id);
}
function getPrizes(activityId) {
  return db.prepare('SELECT * FROM prizes WHERE activity_id=? ORDER BY sort').all(activityId);
}
function publicActivity(a, req) {
  return {
    id: a.id, title: a.title, description: a.description, rules: a.rules,
    images: JSON.parse(a.images || '{}'), status: a.status,
    published_at: a.published_at, created_at: a.created_at, updated_at: a.updated_at,
    draft: a.draft ? JSON.parse(a.draft) : null,
    prizes: getPrizes(a.id),
    link: a.status === 'published' ? activityLink(req, a.id) : null
  };
}
/* 校验并规范化草稿数据 */
function normalizeDraft(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new Error('活动标题不能为空');
  const prizesIn = Array.isArray(body.prizes) ? body.prizes : [];
  if (!prizesIn.length) throw new Error('至少需要配置一个奖项');
  const prizes = prizesIn.map((p, i) => {
    const name = String(p.name || '').trim();
    if (!name) throw new Error(`第 ${i + 1} 个奖项名称不能为空`);
    const amount = Number(p.amount) || 0;
    const num = Math.max(0, Math.floor(Number(p.prob_num)));
    const den = Math.floor(Number(p.prob_den));
    if (!den || den <= 0) throw new Error(`奖项「${name}」概率分母必须为正整数`);
    if (num > den) throw new Error(`奖项「${name}」概率分子不能大于分母`);
    return { name, amount: Math.max(0, amount), prob_num: num || 1, prob_den: den, is_blank: p.is_blank ? 1 : 0 };
  });
  if (!prizes.some(p => p.is_blank)) prizes.push({ name: '谢谢惠顾', amount: 0, prob_num: 1, prob_den: 10, is_blank: 1 });
  return {
    title,
    description: String(body.description || ''),
    rules: String(body.rules || ''),
    images: body.images && typeof body.images === 'object' ? body.images : {},
    prizes
  };
}
function saveDraft(id, body) {
  const draft = normalizeDraft(body);
  db.prepare(`UPDATE activities SET draft=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(JSON.stringify(draft), id);
  return draft;
}
function applyDraft(id) {
  const a = getActivity(id);
  const draft = a.draft ? JSON.parse(a.draft) : null;
  if (draft) {
    db.prepare(`UPDATE activities SET title=?, description=?, rules=?, images=?, status='published',
                 published_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), draft=NULL WHERE id=?`)
      .run(draft.title, draft.description, draft.rules, JSON.stringify(draft.images), id);
    db.prepare('DELETE FROM prizes WHERE activity_id=?').run(id);
    const ins = db.prepare('INSERT INTO prizes(activity_id,name,amount,prob_num,prob_den,is_blank,sort) VALUES(?,?,?,?,?,?,?)');
    draft.prizes.forEach((p, i) => ins.run(id, p.name, p.amount, p.prob_num, p.prob_den, p.is_blank, i));
  } else {
    db.prepare(`UPDATE activities SET status='published', published_at=datetime('now','localtime'),
                 updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  }
}

app.get('/api/admin/activities', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM participants p WHERE p.activity_id=a.id) AS scans,
      (SELECT COUNT(*) FROM participants p WHERE p.activity_id=a.id AND p.drew_at IS NOT NULL) AS draws,
      (SELECT COUNT(*) FROM participants p WHERE p.activity_id=a.id AND p.is_winner=1) AS winners,
      (SELECT ROUND(IFNULL(SUM(p.prize_amount),0),2) FROM participants p WHERE p.activity_id=a.id) AS total_amount
    FROM activities a ORDER BY a.id DESC`).all();
  res.json(rows.map(a => ({ ...publicActivity(a, req), scans: a.scans, draws: a.draws, winners: a.winners, total_amount: a.total_amount })));
});

app.post('/api/admin/activities', requireAdmin, (req, res) => {
  const info = db.prepare("INSERT INTO activities(title,description,rules,status) VALUES('新建抽奖活动','','','draft')").run();
  const ins = db.prepare('INSERT INTO prizes(activity_id,name,amount,prob_num,prob_den,is_blank,sort) VALUES(?,?,?,?,?,?,?)');
  DEFAULT_PRIZES.forEach((p, i) => ins.run(info.lastInsertRowid, p.name, p.amount, p.prob_num, p.prob_den, p.is_blank, i));
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/admin/activities/:id', requireAdmin, (req, res) => {
  const a = getActivity(req.params.id);
  if (!a) return res.status(404).json({ error: '活动不存在' });
  res.json(publicActivity(a, req));
});

app.put('/api/admin/activities/:id/draft', requireAdmin, (req, res) => {
  try {
    const draft = saveDraft(Number(req.params.id), req.body || {});
    res.json({ ok: true, draft });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/activities/:id/publish', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const a = getActivity(id);
  if (!a) return res.status(404).json({ error: '活动不存在' });
  try {
    if (req.body && Object.keys(req.body).length) saveDraft(id, req.body); // 发布前若带草稿数据，先保存
    applyDraft(id);
    res.json({ ok: true, link: activityLink(req, id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/activities/:id/stop', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!getActivity(id)) return res.status(404).json({ error: '活动不存在' });
  db.prepare(`UPDATE activities SET status='stopped', updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  res.json({ ok: true });
});

app.post('/api/admin/activities/:id/duplicate', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const a = getActivity(id);
  if (!a) return res.status(404).json({ error: '活动不存在' });
  const prizes = getPrizes(id);
  const draft = {
    title: a.title + '（副本）', description: a.description, rules: a.rules,
    images: JSON.parse(a.images || '{}'),
    prizes: prizes.map(p => ({ name: p.name, amount: p.amount, prob_num: p.prob_num, prob_den: p.prob_den, is_blank: p.is_blank }))
  };
  const info = db.prepare(`INSERT INTO activities(title,description,rules,images,status,draft) VALUES(?,?,?,?, 'draft', ?)`)
    .run(draft.title, a.description, a.rules, a.images, JSON.stringify(draft));
  const ins = db.prepare('INSERT INTO prizes(activity_id,name,amount,prob_num,prob_den,is_blank,sort) VALUES(?,?,?,?,?,?,?)');
  prizes.forEach((p, i) => ins.run(info.lastInsertRowid, p.name, p.amount, p.prob_num, p.prob_den, p.is_blank, i));
  res.json({ id: info.lastInsertRowid });
});

/* 活动访问二维码（PNG，600px，适合印刷） */
app.get('/api/admin/activities/:id/qrcode.png', requireAdmin, async (req, res) => {
  const a = getActivity(req.params.id);
  if (!a) return res.status(404).json({ error: '活动不存在' });
  const link = activityLink(req, a.id);
  const buf = await QRCode.toBuffer(link, { width: 600, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="lottery-qr-${a.id}.png"`);
  res.send(buf);
});

/* 素材上传（base64） */
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return res.status(400).json({ error: '仅支持 png/jpg/gif/webp 图片' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const fname = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(m[2], 'base64'));
  res.json({ url: `/uploads/${fname}` });
});

/* ---------------- 用户端 H5 接口 ---------------- */
app.get('/api/h5/activity/:id', (req, res) => {
  const a = getActivity(req.params.id);
  if (!a) return res.status(404).json({ error: '活动不存在' });
  const prizes = getPrizes(a.id);
  res.json({
    id: a.id, title: a.title, description: a.description, rules: a.rules,
    images: JSON.parse(a.images || '{}'), status: a.status,
    prizes: prizes.map(p => ({ name: p.name, isBlank: !!p.is_blank }))
  });
});

app.post('/api/h5/join', (req, res) => {
  const { activityId, nickname, phone } = req.body || {};
  const a = getActivity(Number(activityId));
  if (!a) return res.status(404).json({ error: '活动不存在' });
  if (a.status === 'stopped') return res.status(403).json({ error: '活动已结束' });
  if (a.status !== 'published') return res.status(403).json({ error: '活动未开始' });
  const nick = String(nickname || '').trim();
  if (!nick) return res.status(400).json({ error: '请先授权获取微信昵称' });
  const ph = String(phone || '').trim();
  if (!PHONE_RE.test(ph)) return res.status(400).json({ error: '请输入正确的 11 位大陆手机号' });

  const dup = db.prepare('SELECT id, drew_at, prize_name, prize_amount, is_winner FROM participants WHERE activity_id=? AND phone=?')
    .get(a.id, ph);
  if (dup) {
    db.prepare('INSERT INTO duplicate_attempts(activity_id,nickname,phone,user_agent,ip) VALUES(?,?,?,?,?)')
      .run(a.id, nick, ph, String(req.headers['user-agent'] || ''), req.ip || '');
    return res.status(409).json({ code: 'DUPLICATE', error: '该手机号已参与本次抽奖，不可重复参与' });
  }
  const info = db.prepare('INSERT INTO participants(activity_id,nickname,phone,user_agent,referer,ip) VALUES(?,?,?,?,?,?)')
    .run(a.id, nick, ph, String(req.headers['user-agent'] || ''), String(req.headers.referer || ''), req.ip || '');
  res.json({ participantId: info.lastInsertRowid });
});

/* 核心防作弊：服务端抽奖算法（crypto 安全随机数） */
function drawPrize(activityId) {
  const prizes = db.prepare('SELECT * FROM prizes WHERE activity_id=? ORDER BY sort').all(activityId);
  const cash = prizes.filter(p => !p.is_blank).sort((x, y) => y.amount - x.amount);
  for (const p of cash) {
    const r = crypto.randomInt(0, p.prob_den); // [0, den)
    if (r < p.prob_num) return { prize: p, index: prizes.findIndex(x => x.id === p.id) };
  }
  const blank = prizes.find(p => p.is_blank) || prizes[prizes.length - 1];
  return { prize: blank, index: prizes.findIndex(x => x.id === blank.id) };
}

app.post('/api/h5/draw', (req, res) => {
  const { participantId } = req.body || {};
  const p = db.prepare('SELECT * FROM participants WHERE id=?').get(Number(participantId));
  if (!p) return res.status(404).json({ error: '参与记录不存在' });
  if (p.drew_at) { // 幂等：已抽过直接返回历史结果
    const prizes = getPrizes(p.activity_id);
    return res.json({
      already: true, prizeIndex: prizes.findIndex(x => x.id === p.prize_id),
      prizeName: p.prize_name, amount: p.prize_amount, isWinner: !!p.is_winner
    });
  }
  const { prize, index } = drawPrize(p.activity_id);
  db.prepare(`UPDATE participants SET drew_at=datetime('now','localtime'), prize_id=?, prize_name=?, prize_amount=?, is_winner=? WHERE id=? AND drew_at IS NULL`)
    .run(prize.id, prize.name, prize.is_blank ? 0 : prize.amount, prize.is_blank ? 0 : 1, p.id);
  res.json({ prizeIndex: index, prizeName: prize.name, amount: prize.is_blank ? 0 : prize.amount, isWinner: !prize.is_blank });
});

app.get('/api/h5/result/:participantId', (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id=?').get(Number(req.params.participantId));
  if (!p) return res.status(404).json({ error: '记录不存在' });
  const prizes = getPrizes(p.activity_id);
  res.json({
    drew: !!p.drew_at, prizeName: p.prize_name, amount: p.prize_amount, isWinner: !!p.is_winner,
    prizeIndex: p.drew_at ? prizes.findIndex(x => x.id === p.prize_id) : -1
  });
});

/* ---------------- 数据明细与统计 ---------------- */
function buildRecordFilters(query) {
  const where = []; const params = [];
  if (query.activityId) { where.push('p.activity_id = ?'); params.push(Number(query.activityId)); }
  if (query.from) { where.push('date(p.scanned_at) >= ?'); params.push(String(query.from)); }
  if (query.to) { where.push('date(p.scanned_at) <= ?'); params.push(String(query.to)); }
  if (query.phone) { where.push('p.phone LIKE ?'); params.push(`%${String(query.phone).trim()}%`); }
  if (query.drawn === 'yes') where.push('p.drew_at IS NOT NULL');
  if (query.drawn === 'no') where.push('p.drew_at IS NULL');
  if (query.winner === 'yes') where.push('p.is_winner = 1');
  if (query.winner === 'no') where.push('p.is_winner = 0');
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

app.get('/api/admin/records', requireAdmin, (req, res) => {
  const { where, params } = buildRecordFilters(req.query);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) c FROM participants p ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT p.*,
      EXISTS(SELECT 1 FROM duplicate_attempts d WHERE d.activity_id=p.activity_id AND d.phone=p.phone) AS repeat_flag
    FROM participants p ${where}
    ORDER BY p.scanned_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, rows });
});

function getStats(query) {
  const { where, params } = buildRecordFilters(query);
  const daily = db.prepare(`
    SELECT date(p.scanned_at) AS d,
      COUNT(*) AS scans,
      SUM(CASE WHEN p.drew_at IS NOT NULL THEN 1 ELSE 0 END) AS draws,
      SUM(CASE WHEN p.is_winner = 1 THEN 1 ELSE 0 END) AS winners,
      ROUND(IFNULL(SUM(CASE WHEN p.drew_at IS NOT NULL THEN p.prize_amount ELSE 0 END),0),2) AS amount
    FROM participants p ${where}
    GROUP BY d ORDER BY d DESC`).all(...params);
  const totals = db.prepare(`
    SELECT COUNT(*) AS scans,
      SUM(CASE WHEN p.drew_at IS NOT NULL THEN 1 ELSE 0 END) AS draws,
      SUM(CASE WHEN p.is_winner = 1 THEN 1 ELSE 0 END) AS winners,
      ROUND(IFNULL(SUM(p.prize_amount),0),2) AS amount
    FROM participants p ${where}`).get(...params);
  const tiers = db.prepare(`
    SELECT p.prize_name AS name, COUNT(*) AS cnt, ROUND(IFNULL(SUM(p.prize_amount),0),2) AS total
    FROM participants p ${where ? where + ' AND' : 'WHERE'} p.is_winner = 1
    GROUP BY p.prize_name ORDER BY total DESC`).all(...params);
  // 重复参与统计
  const dwhere = []; const dparams = [];
  if (query.activityId) { dwhere.push('activity_id = ?'); dparams.push(Number(query.activityId)); }
  if (query.from) { dwhere.push('date(attempted_at) >= ?'); dparams.push(String(query.from)); }
  if (query.to) { dwhere.push('date(attempted_at) <= ?'); dparams.push(String(query.to)); }
  const dupWhere = dwhere.length ? 'WHERE ' + dwhere.join(' AND ') : '';
  const dup = db.prepare(
    `SELECT COUNT(*) AS attempts, COUNT(DISTINCT phone) AS phones FROM duplicate_attempts ${dupWhere}`
  ).get(...dparams);
  return { daily, totals, tiers, duplicates: dup };
}

app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(getStats(req.query)));

/* ---------------- Excel 导出 ---------------- */
app.get('/api/admin/export/records', requireAdmin, async (req, res) => {
  const { where, params } = buildRecordFilters(req.query);
  const rows = db.prepare(`
    SELECT p.*, EXISTS(SELECT 1 FROM duplicate_attempts d WHERE d.activity_id=p.activity_id AND d.phone=p.phone) AS repeat_flag
    FROM participants p ${where} ORDER BY p.scanned_at DESC`).all(...params);
  const dwhere = []; const dparams = [];
  if (req.query.activityId) { dwhere.push('activity_id = ?'); dparams.push(Number(req.query.activityId)); }
  const dupRows = db.prepare(`SELECT * FROM duplicate_attempts ${dwhere.length ? 'WHERE ' + dwhere.join(' AND ') : ''} ORDER BY attempted_at DESC`).all(...dparams);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('参与明细');
  ws.columns = [
    { header: '扫码时间', key: 'scanned_at', width: 20 },
    { header: '微信昵称', key: 'nickname', width: 18 },
    { header: '手机号', key: 'phone', width: 14 },
    { header: '是否完成抽奖', key: 'drawn', width: 13 },
    { header: '抽奖结果', key: 'result', width: 14 },
    { header: '中奖金额（元）', key: 'amount', width: 14 },
    { header: '抽奖时间', key: 'drew_at', width: 20 },
    { header: '是否重复参与', key: 'repeat', width: 13 },
    { header: '访问来源UA', key: 'ua', width: 40 }
  ];
  for (const r of rows) {
    ws.addRow({
      scanned_at: r.scanned_at, nickname: r.nickname, phone: r.phone,
      drawn: r.drew_at ? '是' : '否',
      result: r.drew_at ? (r.is_winner ? `中奖 ${r.prize_amount} 元` : '谢谢惠顾') : '—',
      amount: r.drew_at ? r.prize_amount : '—',
      drew_at: r.drew_at || '—',
      repeat: r.repeat_flag ? '是' : '否',
      ua: r.user_agent || ''
    });
  }
  const ws2 = wb.addWorksheet('重复尝试记录');
  ws2.columns = [
    { header: '尝试时间', key: 'attempted_at', width: 20 },
    { header: '微信昵称', key: 'nickname', width: 18 },
    { header: '手机号', key: 'phone', width: 14 },
    { header: '活动ID', key: 'activity_id', width: 10 },
    { header: '来源UA', key: 'ua', width: 40 }
  ];
  dupRows.forEach(r => ws2.addRow({ attempted_at: r.attempted_at, nickname: r.nickname, phone: r.phone, activity_id: r.activity_id, ua: r.user_agent || '' }));
  [ws, ws2].forEach(s => s.getRow(1).font = { bold: true });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lottery-records-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/admin/export/stats', requireAdmin, async (req, res) => {
  const s = getStats(req.query);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('每日统计');
  ws.columns = [
    { header: '日期', key: 'd', width: 14 },
    { header: '当日扫码人数', key: 'scans', width: 14 },
    { header: '当日完成抽奖人数', key: 'draws', width: 16 },
    { header: '当日中奖人数', key: 'winners', width: 14 },
    { header: '当日中奖总金额（元）', key: 'amount', width: 20 }
  ];
  s.daily.forEach(r => ws.addRow(r));
  const ws2 = wb.addWorksheet('奖品档位汇总');
  ws2.columns = [
    { header: '奖品名称', key: 'name', width: 16 },
    { header: '中出份数', key: 'cnt', width: 12 },
    { header: '合计金额（元）', key: 'total', width: 16 }
  ];
  s.tiers.forEach(r => ws2.addRow(r));
  const ws3 = wb.addWorksheet('全局汇总');
  ws3.columns = [{ header: '指标', key: 'k', width: 24 }, { header: '数值', key: 'v', width: 24 }];
  ws3.addRow({ k: '累计扫码人数', v: s.totals.scans });
  ws3.addRow({ k: '累计完成抽奖人数', v: s.totals.draws });
  ws3.addRow({ k: '累计中奖人数', v: s.totals.winners });
  ws3.addRow({ k: '累计发放奖金（元）', v: s.totals.amount });
  ws3.addRow({ k: '重复提交尝试次数', v: s.duplicates.attempts });
  ws3.addRow({ k: '重复提交手机号数', v: s.duplicates.phones });
  [ws, ws2, ws3].forEach(x => x.getRow(1).font = { bold: true });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lottery-stats-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/* ---------------- 静态资源 ---------------- */
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin'));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log('=========================================================');
  console.log('  转盘抽奖系统已启动');
  console.log(`  管理后台:  http://localhost:${PORT}/admin`);
  console.log(`  用户端H5:  http://localhost:${PORT}/h5/?a=1`);
  console.log('  默认账号:  admin / admin123');
  console.log('=========================================================');
});
