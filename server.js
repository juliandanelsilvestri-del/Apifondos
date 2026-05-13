/**
 * fonditos - Servidor proxy para API de CAFCI
 * node server.js  →  abrí http://localhost:3000
 */
const express     = require('express');
const fetch       = require('node-fetch');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const CAFCI_BASE = 'https://api.cafci.org.ar';

/* ── CACHE EN MEMORIA ─────────────────────────────────────────────────── */
const _cache = new Map();
function getCache(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data, ttl) { _cache.set(key, { data, exp: Date.now() + ttl }); }

/* ── HELPER FETCH → CAFCI ─────────────────────────────────────────────── */
async function cafciGet(urlPath, ttl = 300000) {
  const hit = getCache(urlPath);
  if (hit) return hit;
  const url = CAFCI_BASE + urlPath;
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin':  'https://www.cafci.org.ar',
      'Referer': 'https://www.cafci.org.ar/',
    },
    timeout: 20000,
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`CAFCI ${r.status} - ${body.slice(0,200)}`);
  }
  const data = await r.json();
  setCache(urlPath, data, ttl);
  return data;
}

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── RUTAS API ────────────────────────────────────────────────────────── */

// Lista completa de fondos con clases
app.get('/api/fondos', async (req, res) => {
  try {
    const data = await cafciGet('/fondo?estado=1&limit=700&include=clase', 10 * 60 * 1000);
    res.json(data);
  } catch (e) {
    console.error('[fondos]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Rendimiento calculado fondo/clase entre 2 fechas (devuelve % directo)
app.get('/api/rendimiento/:fondoId/:claseId/:desde/:hasta', async (req, res) => {
  try {
    const { fondoId, claseId, desde, hasta } = req.params;
    const data = await cafciGet(
      `/fondo/${fondoId}/clase/${claseId}/rendimiento/${desde}/${hasta}`,
      5 * 60 * 1000
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// VCP histórico para gráfico
app.get('/api/vcp/:fondoId/:claseId', async (req, res) => {
  try {
    const { fondoId, claseId } = req.params;
    const { desde, hasta } = req.query;
    const data = await cafciGet(
      `/fondo/${fondoId}/clase/${claseId}/vcp?fechaDesde=${desde}&fechaHasta=${hasta}&limit=500`,
      5 * 60 * 1000
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Bulk: recibe lista [{fondoId,claseId}] + periodo, devuelve rendimientos
app.post('/api/bulk-rendimiento', async (req, res) => {
  const { items, desde, hasta } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] requerido' });

  const out = {};
  const CONCUR = 10;
  for (let i = 0; i < items.length; i += CONCUR) {
    await Promise.allSettled(
      items.slice(i, i + CONCUR).map(async ({ fondoId, claseId }) => {
        const key = `${fondoId}-${claseId}`;
        try {
          const d = await cafciGet(
            `/fondo/${fondoId}/clase/${claseId}/rendimiento/${desde}/${hasta}`,
            5 * 60 * 1000
          );
          out[key] = d;
        } catch(e) { out[key] = null; }
      })
    );
  }
  res.json(out);
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, cache: _cache.size, ts: new Date().toISOString() })
);

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => {
  console.log(`\n🟢  fonditos  →  http://localhost:${PORT}`);
  console.log(`    Proxy API  →  ${CAFCI_BASE}\n`);
});
