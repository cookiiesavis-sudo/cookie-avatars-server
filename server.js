const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { DatabaseSync: Database } = require('node:sqlite');
const { Resend } = require('resend');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Database setup ──────────────────────────────────────────────────────────
const db = new Database('licenses.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    product_id TEXT,
    product_name TEXT,
    used INTEGER DEFAULT 0,
    ip_first_use TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    redeemed_at TEXT
  )
`);

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Products map: Payhip product_id → Google Drive download URL ─────────────
// Add more products here as you create them, keyed by Payhip product ID.
// 'default' is used if no product ID matches.
const PRODUCTS = {
  default: process.env.DEFAULT_DOWNLOAD_URL || ''
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function makeKey() {
  // Generates a key like: COOK-A1B2-C3D4-E5F6
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `COOK-${seg()}-${seg()}-${seg()}`;
}

// ── POST /webhook/payhip ────────────────────────────────────────────────────
app.post('/webhook/payhip', async (req, res) => {
  try {
    console.log('[webhook] payload:', JSON.stringify(req.body));

    // Payhip sends these fields
    const buyerEmail   = (req.body.buyer_email || req.body.email || '').trim().toLowerCase();
    const productId    = req.body.product_id   || req.body.permalink || 'unknown';
    const productName  = req.body.product_name || req.body.title     || 'Cookie Avatar';
    const orderNumber  = req.body.order_number || req.body.order_id  || 'N/A';

    if (!buyerEmail) {
      console.warn('[webhook] No buyer_email in payload');
      return res.status(400).json({ error: 'Missing buyer email' });
    }

    const licenseKey = makeKey();

    db.prepare(`
      INSERT INTO licenses (key, email, product_id, product_name)
      VALUES (?, ?, ?, ?)
    `).run(licenseKey, buyerEmail, productId, productName);

    // Send the key to the buyer
    await resend.emails.send({
      from: 'Cookie Avatars <onboarding@resend.dev>',
      to: buyerEmail,
      subject: '🍪 Your Cookie Avatar License Key',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;
                    background:#1a1a2e;color:#fff;padding:40px;border-radius:12px;">
          <h1 style="color:#e94560;text-align:center;">🍪 Cookie Avatars</h1>
          <h2 style="text-align:center;">Your Download is Ready!</h2>
          <p>Hi! Thank you for purchasing <strong>${productName}</strong>.</p>
          <p>Here is your unique license key — keep it safe!</p>
          <div style="background:#16213e;padding:20px;border-radius:8px;
                      text-align:center;margin:20px 0;border:2px solid #e94560;">
            <code style="font-size:22px;letter-spacing:4px;color:#e94560;
                         font-weight:bold;">${licenseKey}</code>
          </div>
          <p><strong>How to unlock your avatar:</strong></p>
          <ol>
            <li>Download your zip from Payhip and unzip it.</li>
            <li>Open Unity, drag <code>AvatarUnlocker.cs</code> into any
                <code>Editor</code> folder in your project.</li>
            <li>Go to <strong>Tools → Cookie Avatars → Unlock Avatar</strong>.</li>
            <li>Enter your license key and <strong>${buyerEmail}</strong>.</li>
            <li>Click <strong>Unlock</strong> — your avatar will import automatically!</li>
          </ol>
          <p style="color:#888;font-size:12px;margin-top:30px;">
            Order #${orderNumber} · This key is single-use and tied to your email.
          </p>
        </div>
      `
    });

    console.log(`[webhook] Key ${licenseKey} created for ${buyerEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[webhook] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /validate ──────────────────────────────────────────────────────────
app.post('/validate', (req, res) => {
  try {
    const key   = (req.body.key   || '').trim().toUpperCase();
    const email = (req.body.email || '').trim().toLowerCase();
    const ip    = req.headers['x-forwarded-for'] || req.ip || 'unknown';

    if (!key || !email) {
      return res.status(400).json({ valid: false, error: 'Missing key or email' });
    }

    const license = db.prepare(
      'SELECT * FROM licenses WHERE key = ? AND email = ?'
    ).get(key, email);

    if (!license) {
      return res.json({ valid: false, error: 'Invalid license key or email address.' });
    }

    // If already used from a different IP, reject
    if (license.used && license.ip_first_use && license.ip_first_use !== ip) {
      return res.json({
        valid: false,
        error: 'This key has already been activated on another machine.'
      });
    }

    // First-time use: stamp the IP
    if (!license.used) {
      db.prepare(
        'UPDATE licenses SET used=1, ip_first_use=?, redeemed_at=CURRENT_TIMESTAMP WHERE key=?'
      ).run(ip, key);
    }

    const downloadUrl = PRODUCTS[license.product_id] || PRODUCTS['default'];

    res.json({
      valid: true,
      product_name: license.product_name,
      download_url: downloadUrl
    });
  } catch (err) {
    console.error('[validate] Error:', err);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ── GET /admin ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const expected   = 'Basic ' + Buffer.from('admin:' + process.env.ADMIN_PASSWORD).toString('base64');

  if (authHeader !== expected) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cookie Avatars Admin"');
    return res.status(401).send('Unauthorized');
  }

  const licenses = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();

  const rows = licenses.map(l => `
    <tr>
      <td>${l.key}</td>
      <td>${l.email}</td>
      <td>${l.product_name || '-'}</td>
      <td style="color:${l.used ? '#4caf50' : '#ff9800'}">${l.used ? '✅ Used' : '⏳ Pending'}</td>
      <td>${l.ip_first_use || '-'}</td>
      <td>${l.created_at.slice(0,16)}</td>
      <td>${(l.redeemed_at || '-').slice(0,16)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Cookie Avatars Admin</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #0d0d1a; color: #fff; padding: 30px; }
    h1 { color: #e94560; margin-bottom: 6px; }
    p.sub { color: #888; margin-bottom: 24px; }
    .stats { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
    .stat { background: #16213e; padding: 16px 24px; border-radius: 8px;
            border-left: 4px solid #e94560; min-width: 140px; }
    .stat h3 { font-size: 28px; color: #e94560; }
    .stat p { color: #aaa; font-size: 13px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #16213e;
            border-radius: 8px; overflow: hidden; font-size: 13px; }
    th { background: #e94560; padding: 10px 14px; text-align: left; }
    td { padding: 10px 14px; border-bottom: 1px solid #1e2d4a; }
    tr:hover td { background: #1a2a4a; }
  </style>
</head>
<body>
  <h1>🍪 Cookie Avatars — Admin</h1>
  <p class="sub">License key dashboard · All times UTC</p>
  <div class="stats">
    <div class="stat"><h3>${licenses.length}</h3><p>Total Keys</p></div>
    <div class="stat"><h3>${licenses.filter(l=>l.used).length}</h3><p>Activated</p></div>
    <div class="stat"><h3>${licenses.filter(l=>!l.used).length}</h3><p>Unused</p></div>
  </div>
  <table>
    <tr><th>License Key</th><th>Email</th><th>Product</th><th>Status</th>
        <th>IP</th><th>Created</th><th>Redeemed</th></tr>
    ${rows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:#888">No licenses yet — waiting for first purchase!</td></tr>'}
  </table>
</body>
</html>`);
});

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] Cookie Avatars license server listening on :${PORT}`));
