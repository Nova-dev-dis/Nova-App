require('dotenv').config({ path: process.env.ENV_FILE || 'important.env' });

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const axios = require('axios');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';
const OWNER_DISCORD_ID = process.env.OWNER_DISCORD_ID || '';
const CO_OWNER_DISCORD_ID = process.env.CO_OWNER_DISCORD_ID || '';
const SUPPORT_SERVER_URL = process.env.SUPPORT_SERVER_URL || '';
const APP_NAME = 'Nova';
const DATA_DIR = path.join(__dirname, '..', 'data');
const ERROR_FILE = path.join(DATA_DIR, 'errors.log');
const PREMIUM_FILE = path.join(DATA_DIR, 'premium.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function defaultSettings() {
  return {
    emergencyBanner: '',
    founders: [
      { id: OWNER_DISCORD_ID, role: 'Owner' },
      { id: CO_OWNER_DISCORD_ID, role: 'Co-owner' }
    ].filter(x => x.id)
  };
}

function getSettings() {
  return readJson(SETTINGS_FILE, defaultSettings());
}

function saveSettings(settings) {
  writeJson(SETTINGS_FILE, settings);
}

function getPremium() {
  return readJson(PREMIUM_FILE, {});
}

function savePremium(premium) {
  writeJson(PREMIUM_FILE, premium);
}

function logError(error, extra = {}) {
  const line = `[${new Date().toISOString()}] ${error}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}
`;
  fs.appendFileSync(ERROR_FILE, line);
}

function isFounderId(id) {
  return id && (id === OWNER_DISCORD_ID || id === CO_OWNER_DISCORD_ID);
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  next();
}

function requireFounder(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  if (!isFounderId(req.session.user.id)) return res.status(403).json({ ok: false, error: 'Founder access only.' });
  next();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use('/static', express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));

app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    const token = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.data.access_token}` }
    });

    const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${token.data.access_token}` }
    });

    req.session.user = {
      ...userRes.data,
      guilds: guildsRes.data || []
    };

    res.redirect('/dashboard');
  } catch (error) {
    logError(`OAuth callback failed: ${error.message}`);
    res.redirect('/?error=login_failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/api/me', requireLogin, (req, res) => {
  const user = req.session.user;
  const settings = getSettings();
  res.json({
    ok: true,
    appName: APP_NAME,
    user,
    isFounder: isFounderId(user.id),
    founders: settings.founders,
    supportServerUrl: SUPPORT_SERVER_URL
  });
});

app.get('/api/guilds', requireLogin, (req, res) => {
  const premium = getPremium();
  const guilds = (req.session.user.guilds || []).map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    owner: !!g.owner,
    permissions: g.permissions,
    premium: !!premium[g.id]
  }));
  res.json({ ok: true, guilds });
});

app.post('/api/announce/global', requireFounder, (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: 'Missing message.' });
  res.json({ ok: true, sent: true, message });
});

app.post('/api/banner', requireFounder, (req, res) => {
  const { text } = req.body || {};
  const settings = getSettings();
  settings.emergencyBanner = text || '';
  saveSettings(settings);
  res.json({ ok: true, banner: settings.emergencyBanner });
});

app.post('/api/premium/:guildId', requireFounder, (req, res) => {
  const { guildId } = req.params;
  const premium = getPremium();
  premium[guildId] = true;
  savePremium(premium);
  res.json({ ok: true, guildId, premium: true });
});

app.delete('/api/premium/:guildId', requireFounder, (req, res) => {
  const { guildId } = req.params;
  const premium = getPremium();
  delete premium[guildId];
  savePremium(premium);
  res.json({ ok: true, guildId, premium: false });
});

app.post('/api/errors', (req, res) => {
  const { error } = req.body || {};
  logError(error || 'Unknown client error');
  res.json({ ok: true });
});

app.get('/api/errors', requireFounder, (req, res) => {
  const text = fs.existsSync(ERROR_FILE) ? fs.readFileSync(ERROR_FILE, 'utf8') : '';
  res.json({ ok: true, errors: text });
});

app.post('/api/founders', requireFounder, (req, res) => {
  const { id, role } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'Missing id.' });
  const settings = getSettings();
  const existing = settings.founders.filter(f => f.id !== id);
  existing.push({ id, role: role || 'Developer' });
  settings.founders = existing;
  saveSettings(settings);
  res.json({ ok: true, founders: settings.founders });
});

app.use((err, req, res, next) => {
  logError(`Server error: ${err.message}`);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} running on port ${PORT}`);
});
