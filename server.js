// ============================================================
//  أستاذ بجيبك — النسخة الثانية
//  - حل السؤال من الصورة (حد مجاني يومي، ومفتوح لأصحاب الباقة)
//  - امتحان «توقّع معدلك» + الفصول الضعيفة + الفرق عن الكلية
//  - باقة الوزاري بكود تفعيل (دفعة وحدة لحد الامتحان)
//  - صفحة للأهل + رسالة واتساب جاهزة
//  - ترتيب الطالب بمحافظته وبالعراق
//  - لوحة إدارة: إحصائيات، أكواد، إعدادات، زر إيقاف
// ============================================================

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- الإعدادات ----------------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const PROVIDER = process.env.MOCK_AI ? "mock" : CLAUDE_API_KEY ? "claude" : (GEMINI_API_KEY ? "gemini" : "none");
// على Railway: سوّي Volume واربطه بـ /data وحط DATA_DIR=/data حتى ما تنمسح البيانات
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "db.json");

export const PROVINCES = ["بغداد", "البصرة", "نينوى", "أربيل", "النجف", "كربلاء", "ذي قار", "بابل", "الأنبار", "ديالى",
  "واسط", "ميسان", "المثنى", "القادسية", "صلاح الدين", "كركوك", "السليمانية", "دهوك", "حلبجة"];

const DEFAULT_SETTINGS = {
  enabled: true,
  freeDailySolves: 3,          // أسئلة مجانية باليوم
  paidDailySolves: 60,         // سقف يومي لأصحاب الباقة (حماية من الكلفة)
  packagePrice: 25000,         // سعر باقة الوزاري بالدينار
  packageUntil: "2027-06-30",  // الباقة تبقى لحد هالتاريخ
  examDate: "2027-06-12",      // تاريخ الامتحان الوزاري (للعدّاد)
  whatsapp: "",                // رقم واتساب البيع (مثلاً 9647XXXXXXXXX)
  // حدود قبول تقريبية — عدّلها من لوحة الإدارة حسب آخر سنة
  colleges: [
    { name: "الطب", min: 98 },
    { name: "طب الأسنان", min: 97 },
    { name: "الصيدلة", min: 96 },
    { name: "الهندسة", min: 90 },
    { name: "التمريض", min: 88 },
    { name: "العلوم", min: 80 }
  ]
};

// ---------------- قاعدة البيانات (ملف JSON بكتابة آمنة) ----------------
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    d.users ||= {}; d.codes ||= {}; d.stats ||= { totalSolved: 0 };
    return d;
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, users: {}, codes: {}, stats: { totalSolved: 0 } };
  }
}
let db = loadDb();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}
function flushNow() { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
process.on("SIGTERM", () => { try { flushNow(); } catch {} process.exit(0); });

// بنك الأسئلة: نسخة قابلة للتعديل داخل DATA_DIR، وإذا ماكو نستخدم الافتراضية
function questionsPath() {
  const p = path.join(DATA_DIR, "questions.json");
  if (!fs.existsSync(p)) fs.copyFileSync(path.join(__dirname, "questions.json"), p);
  return p;
}
function getBank() { return JSON.parse(fs.readFileSync(questionsPath(), "utf8")); }

// ---------------- أدوات ----------------
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // توقيت بغداد
const newToken = () => crypto.randomBytes(24).toString("hex");
function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  return salt + ":" + crypto.scryptSync(String(pin), salt, 32).toString("hex");
}
function checkPin(pin, stored) {
  const [salt, h] = (stored || "").split(":");
  if (!salt || !h) return false;
  const x = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h));
}
const normPhone = p => String(p || "").replace(/[^\d]/g, "").replace(/^964/, "0").replace(/^7/, "07");
const findUserByToken = t => t && Object.values(db.users).find(u => u.token === t);
const findUserByParent = t => t && Object.values(db.users).find(u => u.parentToken === t);
function isPaid(u) { return !!(u.paidUntil && u.paidUntil >= today()); }
function solvesToday(u) { return u.daily?.date === today() ? u.daily.count : 0; }

// المعدل المتوقع = معدل المواد السبع (الرياضيات والفيزياء من الامتحان، والباقي من تقدير الطالب)
const SUBJECTS = ["الإسلامية", "العربي", "الإنكليزي", "الرياضيات", "الفيزياء", "الكيمياء", "الأحياء"];
function predicted(u) {
  const m = u.marks || {};
  const vals = SUBJECTS.map(s => Number(m[s]));
  if (vals.some(v => !Number.isFinite(v))) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}
function weakChapters(u) {
  const ch = u.chapters || {};
  return Object.entries(ch)
    .map(([name, s]) => ({ name, pct: s.total ? Math.round(100 * s.right / s.total) : 0, ...s }))
    .filter(c => c.pct < 70)
    .sort((a, b) => a.pct - b.pct);
}
function rankOf(u) {
  const p = predicted(u);
  if (p == null) return null;
  const all = Object.values(db.users).map(x => ({ x, p: predicted(x) })).filter(o => o.p != null);
  const prov = all.filter(o => o.x.province === u.province);
  const better = arr => arr.filter(o => o.p > p).length + 1;
  return { iraq: better(all), iraqTotal: all.length, province: better(prov), provinceTotal: prov.length };
}
function publicUser(u) {
  const s = db.settings;
  const target = s.colleges.find(c => c.name === u.target) || s.colleges[0];
  const p = predicted(u);
  return {
    name: u.name, phone: u.phone, province: u.province, target: u.target, targetMin: target?.min,
    paid: isPaid(u), paidUntil: u.paidUntil || null,
    solvesToday: solvesToday(u), freeDaily: s.freeDailySolves, paidDaily: s.paidDailySolves,
    marks: u.marks || {}, quizzes: (u.quizzes || []).slice(-10),
    predicted: p, gap: p != null && target ? Math.round((target.min - p) * 10) / 10 : null,
    weak: weakChapters(u), rank: rankOf(u),
    parentToken: u.parentToken, totalSolves: u.totalSolves || 0
  };
}

// ---------------- التطبيق ----------------
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const u = findUserByToken(req.headers["x-token"]);
  if (!u) return res.status(401).json({ error: "سجّل دخولك من جديد." });
  req.user = u; next();
}

app.get("/api/config", (req, res) => {
  const s = db.settings;
  res.json({ provinces: PROVINCES, colleges: s.colleges, subjects: SUBJECTS, packagePrice: s.packagePrice,
    packageUntil: s.packageUntil, examDate: s.examDate, whatsapp: s.whatsapp, freeDaily: s.freeDailySolves,
    enabled: s.enabled });
});

// تسجيل جديد أو دخول بنفس الرقم والرمز
app.post("/api/register", (req, res) => {
  const { name, phone, pin, province, target } = req.body || {};
  const ph = normPhone(phone);
  if (!/^07\d{9}$/.test(ph)) return res.status(400).json({ error: "اكتب رقم الهاتف صحيح (07xxxxxxxxx)." });
  if (!/^\d{4}$/.test(String(pin || ""))) return res.status(400).json({ error: "الرمز لازم 4 أرقام." });
  const existing = db.users[ph];
  if (existing) {
    if (!checkPin(pin, existing.pin)) return res.status(401).json({ error: "الرقم مسجّل والرمز غلط." });
    existing.token = newToken(); save();
    return res.json({ token: existing.token, user: publicUser(existing) });
  }
  const nm = String(name || "").trim().slice(0, 40);
  if (nm.length < 2) return res.status(400).json({ error: "اكتب اسمك." });
  if (!PROVINCES.includes(province)) return res.status(400).json({ error: "اختار محافظتك." });
  const u = {
    phone: ph, name: nm, pin: hashPin(pin), province,
    target: db.settings.colleges.some(c => c.name === target) ? target : db.settings.colleges[0].name,
    token: newToken(), parentToken: crypto.randomBytes(9).toString("base64url"),
    created: Date.now(), marks: {}, chapters: {}, quizzes: [], totalSolves: 0, solveLog: []
  };
  db.users[ph] = u; save();
  res.json({ token: u.token, user: publicUser(u) });
});

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post("/api/me", auth, (req, res) => {
  const { target, marks, province } = req.body || {};
  const u = req.user;
  if (target && db.settings.colleges.some(c => c.name === target)) u.target = target;
  if (province && PROVINCES.includes(province)) u.province = province;
  if (marks && typeof marks === "object") {
    u.marks ||= {};
    for (const s of ["الإسلامية", "العربي", "الإنكليزي", "الكيمياء", "الأحياء"]) {
      const v = Number(marks[s]);
      if (Number.isFinite(v) && v >= 0 && v <= 100) u.marks[s] = Math.round(v);
    }
  }
  save(); res.json({ user: publicUser(u) });
});

// ---------------- امتحان «توقّع معدلك» ----------------
app.get("/api/quiz/:subject", auth, (req, res) => {
  const bank = getBank()[req.params.subject];
  if (!bank) return res.status(404).json({ error: "مادة غير موجودة." });
  const qs = [...bank].sort(() => Math.random() - 0.5).slice(0, 10)
    .map(({ id, chapter, q, options }) => ({ id, chapter, q, options }));
  res.json({ questions: qs });
});

app.post("/api/quiz/:subject", auth, (req, res) => {
  const subject = req.params.subject;
  const bank = getBank()[subject];
  if (!bank) return res.status(404).json({ error: "مادة غير موجودة." });
  const answers = req.body?.answers || {};
  const u = req.user;
  u.chapters ||= {};
  let right = 0, total = 0;
  const review = [];
  for (const [id, choice] of Object.entries(answers)) {
    const q = bank.find(x => x.id === id);
    if (!q) continue;
    total++;
    const ok = Number(choice) === q.answer;
    if (ok) right++;
    const c = (u.chapters[q.chapter] ||= { right: 0, total: 0, subject });
    c.total++; if (ok) c.right++;
    review.push({ id, chapter: q.chapter, q: q.q, ok, correct: q.options[q.answer], chosen: q.options[choice] ?? "—" });
  }
  if (!total) return res.status(400).json({ error: "ما جاوبت على شي." });
  const score = Math.round(100 * right / total);
  const subjName = subject === "math" ? "الرياضيات" : "الفيزياء";
  u.marks ||= {};
  u.marks[subjName] = score;
  u.quizzes ||= [];
  u.quizzes.push({ subject: subjName, score, right, total, at: Date.now() });
  save();
  res.json({ score, right, total, review, user: publicUser(u) });
});

// ---------------- حل السؤال من الصورة ----------------
function buildPrompt(subject) {
  const subj = subject === "physics" ? "فيزياء" : "رياضيات";
  const common = `أنت مدرس عراقي خبير للصف السادس العلمي، أسلوبك مثل أفضل الملازم العراقية. تحل السؤال المصوّر على طريقة الكتاب الوزاري العراقي بالضبط، وبطريقة يفهمها طالب متوسط المستوى.

قواعد صارمة:
1. اقرأ الصورة بدقة. إذا مو واضحة أو مو سؤال ${subj}، قل بجملة وحدة إن الصورة غير واضحة أو المادة غلط، واطلب صورة أوضح. لا تحل شي.
2. إذا بالصورة أكثر من سؤال أو فرع، حل كل واحد بقسم منفصل بعنوانه.
3. استخدم مصطلحات الكتاب العراقي الرسمية فقط.
4. كل خطوة = فكرة وحدة، بعنوان قصير، وبعدها السطور الرياضية.
5. تحت كل خطوة سطر واحد يبدأ بـ "بالعراقي:" بلهجة عراقية بسيطة (ما يتجاوز 15 كلمة).
6. استخدم رموز يقراها الطالب (x^2، √، ∫، π، ⇒، ∴) وبدون LaTeX.
7. لا تطوّل ولا تكرر. الدقة أهم من الطول.
8. تحقق من الجواب بطريقة ثانية أو بالتعويض.`;
  const math = `\n\nخاص بالرياضيات: اتبع ترتيب الكتاب، واستخدم ∴ و ⇒، واكتب الوحدة (وحدة مربعة / وحدة مكعبة) عند الحاجة.`;
  const physics = `\n\nخاص بالفيزياء: رتّب: المعطيات (بعد تحويل الوحدات للنظام الدولي) ← المطلوب ← القانون ← التعويض ← الناتج مع الوحدة. إذا السؤال نظري (علل / ما الفرق)، جاوب بنقاط مختصرة مثل أجوبة الكتاب.`;
  const format = `

اكتب الجواب بهذا الترتيب بالضبط (### للعناوين و ** للخط العريض):

### 📘 السؤال
### 💡 فكرة السؤال
### ✍️ الحل
**الخطوة 1: (عنوان قصير)**
(السطور)
بالعراقي: (جملة)
### ✅ الجواب النهائي
### ⚠️ انتبه
(أكثر غلط يسويه الطلاب)
### 🔎 تحقق`;
  return common + (subject === "physics" ? physics : math) + format;
}

// سبب الخطأ بالعربي حتى نعرف شنو صار بالضبط
function reasonAr(status, body) {
  const b = (body || "").toLowerCase();
  if (status === 401 || b.includes("api key not valid") || b.includes("invalid x-api-key") || b.includes("authentication"))
    return "مفتاح الذكاء الاصطناعي غلط أو منتهي.";
  if (b.includes("credit balance") || b.includes("billing") || status === 402) return "رصيد الذكاء الاصطناعي خلص. لازم تشحن.";
  if (status === 429 || b.includes("quota") || b.includes("rate")) return "الحصة المجانية خلصت أو ضغط كبير. جرب بعد دقيقة.";
  if (status === 529 || status === 503 || b.includes("overloaded")) return "خدمة الذكاء الاصطناعي مزدحمة هسه. جرب بعد شوية.";
  return "خطأ " + status;
}
class AIError extends Error { constructor(msg, detail) { super(msg); this.detail = detail; } }

async function askAI(prompt, image, media) {
  if (PROVIDER === "mock") return "### 📘 السؤال\nجد ∫ 3x^2 dx\n### ✍️ الحل\n**الخطوة 1: نكامل**\n= x^3 + c\nبالعراقي: نزيد الأس واحد ونقسم عليه.\n### ✅ الجواب النهائي\n**x^3 + c**";
  let lastStatus = 0, lastBody = "";
  if (PROVIDER === "claude") {
    const models = [CLAUDE_MODEL, "claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const model of models) {
      const content = image
        ? [{ type: "image", source: { type: "base64", media_type: media, data: image } }, { type: "text", text: prompt }]
        : [{ type: "text", text: prompt }];
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content }] })
      });
      if (r.ok) { const j = await r.json(); return (j.content || []).filter(p => p.type === "text").map(p => p.text).join(""); }
      lastStatus = r.status; lastBody = (await r.text()).slice(0, 400);
      console.error("Claude", model, lastStatus, lastBody);
      // إذا المشكلة بالموديل نجرب اللي بعده، غير هيج نوقف
      if (!(r.status === 404 || (r.status === 400 && lastBody.toLowerCase().includes("model")))) break;
    }
  } else {
    const models = [GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const m of models) {
      const parts = image ? [{ text: prompt }, { inline_data: { mime_type: media, data: image } }] : [{ text: prompt }];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } })
      });
      if (r.ok) { const j = await r.json(); return j?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || ""; }
      lastStatus = r.status; lastBody = (await r.text()).slice(0, 400);
      console.error("Gemini", m, lastStatus, lastBody);
      if (r.status === 401 || r.status === 403) break;
    }
  }
  throw new AIError(reasonAr(lastStatus, lastBody), `${PROVIDER} ${lastStatus}: ${lastBody}`);
}

app.get("/api/admin/test-ai", admin, async (req, res) => {
  try {
    const t = Date.now();
    const a = await askAI("جاوب بكلمة وحدة: كم ناتج 2+2؟", null, null);
    res.json({ ok: true, provider: PROVIDER, ms: Date.now() - t, answer: a.slice(0, 100) });
  } catch (e) { res.json({ ok: false, provider: PROVIDER, error: e.message, detail: e.detail || String(e) }); }
});

app.post("/api/solve", auth, async (req, res) => {
  const s = db.settings, u = req.user;
  if (!s.enabled) return res.status(403).json({ error: "الخدمة موقوفة مؤقتاً. ارجع بعد شوية." });
  if (PROVIDER === "none") return res.status(500).json({ error: "ماكو مفتاح ذكاء اصطناعي على السيرفر." });
  const limit = isPaid(u) ? s.paidDailySolves : s.freeDailySolves;
  const used = solvesToday(u);
  if (used >= limit) {
    return res.status(402).json({ error: isPaid(u) ? "وصلت الحد اليومي. ارجع باچر." : "خلصت أسئلتك المجانية لليوم.",
      needPackage: !isPaid(u) });
  }
  const { image, mimeType, subject } = req.body || {};
  if (!image || image.length > 7_000_000) return res.status(400).json({ error: "الصورة مفقودة أو كبيرة كلش." });
  try {
    const answer = await askAI(buildPrompt(subject), image, mimeType || "image/jpeg");
    if (!answer) return res.status(502).json({ error: "ما رجع حل. جرب صورة أوضح." });
    u.daily = { date: today(), count: used + 1 };
    u.totalSolves = (u.totalSolves || 0) + 1;
    u.solveLog ||= [];
    u.solveLog.push({ at: Date.now(), subject: subject === "physics" ? "الفيزياء" : "الرياضيات" });
    if (u.solveLog.length > 300) u.solveLog = u.solveLog.slice(-300);
    db.stats.totalSolved++;
    save();
    res.json({ answer, user: publicUser(u) });
  } catch (e) {
    console.error(e.detail || e.message);
    res.status(502).json({ error: "ما گدرنا نحل السؤال: " + (e.message || "خطأ غير معروف") });
  }
});

// ---------------- تفعيل الباقة بالكود ----------------
const attempts = new Map();
app.post("/api/redeem", auth, (req, res) => {
  const u = req.user;
  const key = u.phone;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 3600e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: "محاولات كثيرة. جرب بعد ساعة." });
  a.n++; attempts.set(key, a);
  const code = String(req.body?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const c = db.codes[code];
  if (!c) return res.status(404).json({ error: "الكود غلط." });
  if (c.usedBy) return res.status(409).json({ error: "هذا الكود مستخدم قبل." });
  c.usedBy = u.phone; c.usedAt = Date.now();
  u.paidUntil = db.settings.packageUntil;
  save();
  res.json({ ok: true, user: publicUser(u) });
});

// ---------------- صفحة الأهل ----------------
app.get("/api/parent/:t", (req, res) => {
  const u = findUserByParent(req.params.t);
  if (!u) return res.status(404).json({ error: "الرابط غير صحيح." });
  const week = Date.now() - 7 * 864e5;
  const p = publicUser(u);
  res.json({
    name: u.name, province: u.province, target: u.target, targetMin: p.targetMin, predicted: p.predicted, gap: p.gap,
    weak: p.weak.slice(0, 5), rank: p.rank, paid: p.paid,
    weekSolves: (u.solveLog || []).filter(x => x.at > week).length,
    weekQuizzes: (u.quizzes || []).filter(x => x.at > week),
    lastQuizzes: (u.quizzes || []).slice(-6), totalSolves: u.totalSolves || 0
  });
});

// ---------------- لوحة الإدارة ----------------
function admin(req, res, next) {
  const pass = req.headers["x-admin-pass"] || "";
  const ok = pass.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: "كلمة السر غلط." });
  next();
}

app.get("/api/admin/overview", admin, (req, res) => {
  const users = Object.values(db.users);
  const t = today();
  const codes = Object.entries(db.codes).map(([code, c]) => ({ code, ...c }));
  res.json({
    provider: PROVIDER,
    settings: db.settings,
    stats: {
      users: users.length,
      paid: users.filter(isPaid).length,
      activeToday: users.filter(u => u.daily?.date === t).length,
      solvesToday: users.reduce((a, u) => a + solvesToday(u), 0),
      totalSolved: db.stats.totalSolved,
      quizzes: users.reduce((a, u) => a + (u.quizzes?.length || 0), 0),
      codesFree: codes.filter(c => !c.usedBy).length,
      codesUsed: codes.filter(c => c.usedBy).length,
      revenue: codes.filter(c => c.usedBy).length * db.settings.packagePrice
    },
    users: users.sort((a, b) => b.created - a.created).slice(0, 300).map(u => ({
      name: u.name, phone: u.phone, province: u.province, target: u.target, paid: isPaid(u),
      predicted: predicted(u), totalSolves: u.totalSolves || 0, quizzes: u.quizzes?.length || 0, created: u.created
    })),
    codes: codes.sort((a, b) => b.created - a.created).slice(0, 500)
  });
});

app.post("/api/admin/codes", admin, (req, res) => {
  const n = Math.min(500, Math.max(1, Number(req.body?.count) || 10));
  const note = String(req.body?.note || "").slice(0, 60);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const made = [];
  while (made.length < n) {
    let c = "";
    for (let i = 0; i < 8; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    if (db.codes[c]) continue;
    db.codes[c] = { created: Date.now(), note };
    made.push(c);
  }
  save();
  res.json({ codes: made });
});

app.post("/api/admin/settings", admin, (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  if (typeof b.enabled === "boolean") s.enabled = b.enabled;
  for (const k of ["freeDailySolves", "paidDailySolves", "packagePrice"]) if (Number.isFinite(Number(b[k])) && b[k] !== "") s[k] = Number(b[k]);
  for (const k of ["packageUntil", "examDate"]) if (/^\d{4}-\d{2}-\d{2}$/.test(b[k] || "")) s[k] = b[k];
  if (typeof b.whatsapp === "string") s.whatsapp = b.whatsapp.replace(/[^\d]/g, "");
  if (Array.isArray(b.colleges)) {
    const cl = b.colleges.filter(c => c && c.name && Number.isFinite(Number(c.min)))
      .map(c => ({ name: String(c.name).slice(0, 40), min: Number(c.min) }));
    if (cl.length) s.colleges = cl;
  }
  save(); res.json({ settings: s });
});

app.post("/api/admin/grant", admin, (req, res) => {
  const u = db.users[normPhone(req.body?.phone)];
  if (!u) return res.status(404).json({ error: "ما لقيت هالرقم." });
  u.paidUntil = req.body?.revoke ? null : db.settings.packageUntil;
  save(); res.json({ ok: true, paid: isPaid(u) });
});

app.get("/api/admin/questions", admin, (req, res) => res.json(getBank()));
app.post("/api/admin/questions", admin, (req, res) => {
  const b = req.body;
  const valid = b && ["math", "physics"].every(k => Array.isArray(b[k]) && b[k].every(q =>
    q.id && q.chapter && q.q && Array.isArray(q.options) && q.options.length >= 2 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length));
  if (!valid) return res.status(400).json({ error: "صيغة الأسئلة غلط. كل سؤال يحتاج id و chapter و q و options و answer." });
  fs.writeFileSync(questionsPath(), JSON.stringify(b, null, 2));
  res.json({ ok: true });
});

app.get("/healthz", (_, res) => res.send("ok"));
app.get("/p/:t", (_, res) => res.sendFile(path.join(__dirname, "public", "parent.html")));

app.listen(PORT, () => console.log(`أستاذ بجيبك v2 على المنفذ ${PORT} — المزود: ${PROVIDER} — البيانات: ${DATA_DIR}`));
