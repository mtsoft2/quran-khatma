const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'quran_khatma';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const makeId = () => crypto.randomBytes(6).toString('hex');
const makeToken = () => crypto.randomBytes(16).toString('hex');

function emptyJuz() {
  return Array.from({ length: 30 }, (_, i) => ({ number: i + 1, readers: [] }));
}

function newKhatma(name, intro = '', deadline = null, allowMultipleReaders = true) {
  return {
    id: makeId(),
    name: name || 'ختمة جديدة',
    intro: intro || 'بسم الله الرحمن الرحيم. أهلاً بكم في الختمة المباركة.',
    deadline: deadline || null,
    allowMultipleReaders: !!allowMultipleReaders,
    createdAt: new Date().toISOString(),
    archived: false,
    juz: emptyJuz()
  };
}

function defaultData() {
  const k = newKhatma('ختمة عامة', 'بسم الله الرحمن الرحيم. أهلاً بكم في ختمة القرآن الكريم.');
  return { khatmas: [k] };
}

function normalize(data) {
  if (data.khatmas) {
    for (const k of data.khatmas) {
      if (typeof k.allowMultipleReaders !== 'boolean') k.allowMultipleReaders = true;
    }
    return data;
  }
  // Legacy migration: wrap single-khatma data
  const legacy = newKhatma('ختمة عامة', data.intro || '');
  if (Array.isArray(data.juz)) {
    legacy.juz = data.juz.map((j, i) => ({
      number: j.number || (i + 1),
      readers: Array.isArray(j.readers) ? j.readers : (j.reservedBy ? [{
        name: j.reservedBy, reservedAt: j.reservedAt || null,
        read: !!j.read, readAt: j.readAt || null
      }] : [])
    }));
  }
  return { khatmas: [legacy] };
}

// === Storage backends ===

let store;
if (MONGODB_URI) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI);
  let collection;
  store = {
    async init() {
      await client.connect();
      collection = client.db(MONGODB_DB).collection('state');
      const existing = await collection.findOne({ _id: 'main' });
      if (!existing) {
        await collection.insertOne({ _id: 'main', ...defaultData() });
      }
      console.log(`Connected to MongoDB (db: ${MONGODB_DB})`);
    },
    async load() {
      const doc = await collection.findOne({ _id: 'main' });
      if (!doc) {
        const d = defaultData();
        await collection.insertOne({ _id: 'main', ...d });
        return d;
      }
      const { _id, ...data } = doc;
      const normalized = normalize(data);
      if (!data.khatmas) {
        await collection.replaceOne({ _id: 'main' }, { _id: 'main', ...normalized });
      }
      return normalized;
    },
    async save(data) {
      await collection.replaceOne(
        { _id: 'main' },
        { _id: 'main', ...data },
        { upsert: true }
      );
    }
  };
} else {
  store = {
    async init() {
      console.log(`Using local file storage: ${DATA_FILE}`);
    },
    async load() {
      if (!fs.existsSync(DATA_FILE)) {
        const d = defaultData();
        fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8');
        return d;
      }
      return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    },
    async save(data) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    }
  };
}

function findKhatma(data, id) {
  return data.khatmas.find(k => k.id === id);
}

function publicKhatma(k) {
  return {
    id: k.id, name: k.name, intro: k.intro,
    deadline: k.deadline, createdAt: k.createdAt, archived: k.archived,
    allowMultipleReaders: !!k.allowMultipleReaders,
    juz: k.juz.map(j => ({
      number: j.number,
      readers: j.readers.map(r => ({
        name: r.name, reservedAt: r.reservedAt, read: r.read, readAt: r.readAt
      }))
    }))
  };
}

// === Public API ===

app.get('/api/khatmas', async (req, res) => {
  const data = await store.load();
  res.json(data.khatmas.map(k => ({
    id: k.id, name: k.name, archived: k.archived,
    deadline: k.deadline, createdAt: k.createdAt,
    juzCount: k.juz.length,
    readersCount: k.juz.reduce((s, j) => s + j.readers.length, 0),
    readCount: k.juz.filter(j => j.readers.some(r => r.read)).length,
    availableCount: k.juz.filter(j => j.readers.length === 0).length
  })));
});

app.get('/api/khatma/:id', async (req, res) => {
  const data = await store.load();
  const k = findKhatma(data, req.params.id);
  if (!k) return res.status(404).json({ error: 'ختمة غير موجودة' });
  res.json(publicKhatma(k));
});

app.post('/api/reserve', async (req, res) => {
  const { khatmaId, number, name } = req.body;
  const n = (name || '').trim();
  if (!khatmaId || !number || !n) return res.status(400).json({ error: 'بيانات ناقصة' });
  const data = await store.load();
  const k = findKhatma(data, khatmaId);
  if (!k) return res.status(404).json({ error: 'ختمة غير موجودة' });
  if (k.archived) return res.status(400).json({ error: 'هذه الختمة مؤرشفة' });
  const juz = k.juz.find(j => j.number === Number(number));
  if (!juz) return res.status(404).json({ error: 'جزء غير موجود' });
  if (juz.readers.find(r => r.name === n)) {
    return res.status(409).json({ error: 'يوجد قارئ بنفس الاسم في هذا الجزء' });
  }
  if (!k.allowMultipleReaders && juz.readers.length > 0) {
    return res.status(409).json({ error: 'هذا الجزء محجوز بالفعل (قارئ واحد فقط لكل جزء)' });
  }
  const token = makeToken();
  juz.readers.push({ name: n, token, reservedAt: new Date().toISOString(), read: false, readAt: null });
  await store.save(data);
  res.json({ ok: true, token });
});

async function authReader(req, res) {
  const { khatmaId, number, name, token } = req.body;
  const n = (name || '').trim();
  const data = await store.load();
  const k = findKhatma(data, khatmaId);
  if (!k) { res.status(404).json({ error: 'ختمة غير موجودة' }); return null; }
  const juz = k.juz.find(j => j.number === Number(number));
  if (!juz) { res.status(404).json({ error: 'جزء غير موجود' }); return null; }
  const r = juz.readers.find(x => x.name === n);
  if (!r) { res.status(404).json({ error: 'لم يتم العثور على حجزك' }); return null; }
  if (!r.token || r.token !== token) {
    res.status(403).json({ error: 'غير مصرّح. فقط من حجز الجزء يمكنه التعديل' });
    return null;
  }
  return { data, khatma: k, juz, reader: r };
}

app.post('/api/mark-read', async (req, res) => {
  const ctx = await authReader(req, res); if (!ctx) return;
  ctx.reader.read = true;
  ctx.reader.readAt = new Date().toISOString();
  await store.save(ctx.data);
  res.json({ ok: true });
});

app.post('/api/unmark-read', async (req, res) => {
  const ctx = await authReader(req, res); if (!ctx) return;
  ctx.reader.read = false;
  ctx.reader.readAt = null;
  await store.save(ctx.data);
  res.json({ ok: true });
});

app.post('/api/release', async (req, res) => {
  const ctx = await authReader(req, res); if (!ctx) return;
  ctx.juz.readers = ctx.juz.readers.filter(r => r !== ctx.reader);
  await store.save(ctx.data);
  res.json({ ok: true });
});

// === Admin API (no auth) ===

app.post('/api/admin/khatma/create', async (req, res) => {
  const { name, intro, deadline, allowMultipleReaders } = req.body;
  const data = await store.load();
  const k = newKhatma(name, intro, deadline, allowMultipleReaders !== false);
  data.khatmas.push(k);
  await store.save(data);
  res.json({ ok: true, id: k.id });
});

app.post('/api/admin/khatma/update', async (req, res) => {
  const { id, name, intro, deadline, allowMultipleReaders } = req.body;
  const data = await store.load();
  const k = findKhatma(data, id);
  if (!k) return res.status(404).json({ error: 'ختمة غير موجودة' });
  if (typeof name === 'string' && name.trim()) k.name = name.trim();
  if (typeof intro === 'string') k.intro = intro;
  if (deadline !== undefined) k.deadline = deadline || null;
  if (typeof allowMultipleReaders === 'boolean') k.allowMultipleReaders = allowMultipleReaders;
  await store.save(data);
  res.json({ ok: true });
});

app.post('/api/admin/khatma/archive', async (req, res) => {
  const { id, archived } = req.body;
  const data = await store.load();
  const k = findKhatma(data, id);
  if (!k) return res.status(404).json({ error: 'ختمة غير موجودة' });
  k.archived = !!archived;
  await store.save(data);
  res.json({ ok: true });
});

app.post('/api/admin/khatma/delete', async (req, res) => {
  const { id } = req.body;
  const data = await store.load();
  const i = data.khatmas.findIndex(k => k.id === id);
  if (i === -1) return res.status(404).json({ error: 'ختمة غير موجودة' });
  data.khatmas.splice(i, 1);
  await store.save(data);
  res.json({ ok: true });
});

app.post('/api/admin/reset-juz', async (req, res) => {
  const { khatmaId, number } = req.body;
  const data = await store.load();
  const k = findKhatma(data, khatmaId);
  if (!k) return res.status(404).json({ error: 'ختمة غير موجودة' });
  const juz = k.juz.find(j => j.number === Number(number));
  if (!juz) return res.status(404).json({ error: 'جزء غير موجود' });
  juz.readers = [];
  await store.save(data);
  res.json({ ok: true });
});

app.post('/api/admin/remove-reader', async (req, res) => {
  const { khatmaId, number, name } = req.body;
  const data = await store.load();
  const k = findKhatma(data, khatmaId);
  if (!k) return res.status(404).json({ error: 'ختمة غير موجودة' });
  const juz = k.juz.find(j => j.number === Number(number));
  if (!juz) return res.status(404).json({ error: 'جزء غير موجود' });
  juz.readers = juz.readers.filter(r => r.name !== name);
  await store.save(data);
  res.json({ ok: true });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'خطأ في الخادم' });
});

(async () => {
  await store.init();
  app.listen(PORT, () => {
    console.log(`Quran Juz Tracker running on http://localhost:${PORT}`);
  });
})();
