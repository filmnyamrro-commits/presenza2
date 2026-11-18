import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import nodemailer from 'nodemailer';

export const PRIMARY_OWNER_EMAIL = 'rohantmr.lover@gmail.com';
export const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_WRONG_ATTEMPTS = 5;
export const VERIFY_LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes
export const REQUEST_COOLDOWN_MS = 30 * 1000; // 30 seconds between code requests per device
export const MAX_REQUESTS_PER_15M = 6;
export const DEVICE_TOKEN_COOKIE = 'presenza_device_token';

const FIREBASE_PROJECT_ID = readFirebaseProjectId();
const DATA_DIR = path.resolve(process.cwd(), '.presenza-data');
const STORE_PATH = path.join(DATA_DIR, 'device-auth-store.json');

function readFirebaseProjectId(): string {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    if (typeof parsed.projectId === 'string' && parsed.projectId.trim()) {
      return parsed.projectId.trim();
    }
  } catch {
    // Fallback below
  }
  return 'tribal-adviser-r8f9p';
}

export interface StoredDeviceRecord {
  deviceId: string;
  deviceName: string;
  userAgentSummary: string;
  status: 'active' | 'revoked';
  authorizedBy: 'code' | 'owner-google' | 'owner-direct';
  authorizedAtIso: string;
  lastSeenAtIso: string;
  revokedAtIso?: string;
}

interface StoredChallenge {
  challengeId: string;
  targetDeviceId: string; // specific deviceId or '*' for owner-issued invite code
  deviceName: string;
  userAgentSummary: string;
  codeHash: string;
  expiresAtMs: number;
  createdAtMs: number;
  attempts: number;
  maxAttempts: number;
  used: boolean;
  emailSent: boolean;
  directApproved?: boolean;
  directClaimed?: boolean;
}

export interface DeviceSecurityPolicy {
  allowDirectQrWithoutDeviceAuth: boolean;
}

interface PersistedDeviceStore {
  serverSecret: string;
  devices: Record<string, StoredDeviceRecord>;
  challenges: Record<string, StoredChallenge>;
  lockouts: Record<string, number>;
  requestTimestamps: Record<string, number[]>;
  policy: DeviceSecurityPolicy;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_\-]{8,128}$/;

function createDefaultStore(): PersistedDeviceStore {
  return {
    serverSecret: crypto.randomBytes(32).toString('hex'),
    devices: {},
    challenges: {},
    lockouts: {},
    requestTimestamps: {},
    policy: {
      allowDirectQrWithoutDeviceAuth: false,
    },
  };
}

let cachedStore: PersistedDeviceStore | null = null;

function loadStore(): PersistedDeviceStore {
  if (cachedStore) return cachedStore;

  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedDeviceStore>;
      const fallback = createDefaultStore();
      cachedStore = {
        serverSecret:
          typeof parsed.serverSecret === 'string' && parsed.serverSecret.length >= 32
            ? parsed.serverSecret
            : fallback.serverSecret,
        devices: parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
        challenges:
          parsed.challenges && typeof parsed.challenges === 'object' ? parsed.challenges : {},
        lockouts: parsed.lockouts && typeof parsed.lockouts === 'object' ? parsed.lockouts : {},
        requestTimestamps:
          parsed.requestTimestamps && typeof parsed.requestTimestamps === 'object'
            ? parsed.requestTimestamps
            : {},
        policy: {
          allowDirectQrWithoutDeviceAuth: Boolean(
            parsed.policy?.allowDirectQrWithoutDeviceAuth
          ),
        },
      };
      return cachedStore;
    }
  } catch (err) {
    console.warn('Unable to read device-auth store, initializing fresh store:', err);
  }

  cachedStore = createDefaultStore();
  saveStore(cachedStore);
  return cachedStore;
}

function saveStore(store: PersistedDeviceStore): void {
  pruneExpiredState(store);
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    console.warn('Warning: failed to persist device-auth store to disk:', err);
  }
}

function pruneExpiredState(store: PersistedDeviceStore): void {
  const now = Date.now();
  const maxChallengeRetentionMs = 24 * 60 * 60 * 1000;
  for (const [id, ch] of Object.entries(store.challenges)) {
    if (now - ch.createdAtMs > maxChallengeRetentionMs) {
      delete store.challenges[id];
    }
  }
  for (const [key, until] of Object.entries(store.lockouts)) {
    if (until <= now) {
      delete store.lockouts[key];
    }
  }
  const windowCutoff = now - 15 * 60 * 1000;
  for (const [key, stamps] of Object.entries(store.requestTimestamps)) {
    const filtered = stamps.filter((ts) => ts > windowCutoff);
    if (filtered.length === 0) {
      delete store.requestTimestamps[key];
    } else {
      store.requestTimestamps[key] = filtered;
    }
  }
}

function getSigningSecret(store: PersistedDeviceStore): string {
  const envSecret = (process.env.DEVICE_AUTH_SECRET || '').trim();
  if (envSecret && envSecret.length >= 16 && envSecret !== 'CHANGE_TO_LONG_RANDOM_SECRET') {
    return envSecret;
  }
  return store.serverSecret;
}

function hashVerificationCode(
  secret: string,
  challengeId: string,
  code: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`code:${challengeId}:${code}`)
    .digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!VALID_ID_REGEX.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeDeviceName(raw: unknown, fallback = 'Authorized Device'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
  return cleaned || fallback;
}

export function summarizeUserAgent(req: Request): string {
  const ua = String(req.headers['user-agent'] || '').trim();
  if (!ua) return 'Unknown Browser';
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Google Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Mozilla Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';

  return `${browser} on ${os}`.slice(0, 180);
}

function getClientIpKey(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : typeof xff === 'string' ? xff.split(',')[0] : req.ip;
  return String(raw || 'unknown').trim().slice(0, 64);
}

interface DeviceTokenPayload {
  deviceId: string;
  nonce: string;
  issuedAtMs: number;
}

export function signDeviceToken(
  store: PersistedDeviceStore,
  deviceId: string
): string {
  const payload: DeviceTokenPayload = {
    deviceId,
    nonce: crypto.randomBytes(12).toString('hex'),
    issuedAtMs: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret(store))
    .update(`token:${encoded}`)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySignedDeviceToken(
  store: PersistedDeviceStore,
  token: string
): DeviceTokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret(store))
    .update(`token:${encoded}`)
    .digest('base64url');

  if (!timingSafeHexEqual(sig, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as Partial<DeviceTokenPayload>;
    const deviceId = sanitizeDeviceId(parsed.deviceId);
    if (!deviceId || typeof parsed.issuedAtMs !== 'number') {
      return null;
    }
    return {
      deviceId,
      nonce: String(parsed.nonce || ''),
      issuedAtMs: parsed.issuedAtMs,
    };
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function extractDeviceTokenFromRequest(req: Request): string | null {
  const headerToken = req.headers['x-device-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const bodyToken = (req.body as { deviceToken?: unknown } | undefined)?.deviceToken;
  if (typeof bodyToken === 'string' && bodyToken.trim()) {
    return bodyToken.trim();
  }
  const cookies = parseCookies(req);
  if (cookies[DEVICE_TOKEN_COOKIE]) {
    return cookies[DEVICE_TOKEN_COOKIE];
  }
  return null;
}

function setDeviceTokenCookie(req: Request, res: Response, token: string): void {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').includes('https');
  const maxAge = 365 * 24 * 60 * 60;
  const parts = [
    `${DEVICE_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    isHttps ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (isHttps) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearDeviceTokenCookie(req: Request, res: Response): void {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').includes('https');
  const parts = [
    `${DEVICE_TOKEN_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    isHttps ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (isHttps) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Email delivery status helper (never leaks passwords or keys)
export function getEmailTransportStatus(): {
  configured: boolean;
  provider: 'resend' | 'smtp' | 'none';
} {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    return { configured: true, provider: 'resend' };
  }
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  if (smtpUser && smtpPass) {
    return { configured: true, provider: 'smtp' };
  }
  return { configured: false, provider: 'none' };
}

async function sendOwnerVerificationEmail(params: {
  code: string;
  deviceName: string;
  userAgentSummary: string;
  expiresAtIso: string;
}): Promise<{ delivered: boolean; provider: 'resend' | 'smtp' | 'none'; note: string }> {
  const { code, deviceName, userAgentSummary, expiresAtIso } = params;
  const appUrl = (process.env.APP_URL || '').trim();
  const subject = `[PRESENZA] Device Verification Code: ${code}`;
  const textBody = [
    `PRESENZA Cross-Device Verification`,
    ``,
    `A device is requesting access to your PRESENZA attendance application:`,
    `- Device Label: ${deviceName}`,
    `- Browser / OS: ${userAgentSummary}`,
    `- Verification Code: ${code}`,
    `- Valid Until: ${expiresAtIso} (5 minutes, single-use only)`,
    appUrl ? `- Application URL: ${appUrl}` : '',
    ``,
    `Share this code only with an authorized person. If you did not expect this request, ignore this email or revoke unauthorized devices in your Owner Console.`,
  ]
    .filter(Boolean)
    .join('\n');

  const htmlBody = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:16px;background:#ffffff;color:#0f172a">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:#1d4ed8;text-transform:uppercase">PRESENZA SECURITY</div>
      <h2 style="margin:8px 0 12px;font-size:20px;color:#0f172a">New Device Access Request</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.5">
        A new device is requesting access to your PRESENZA application. Enter or share this temporary single-use code within <strong>5 minutes</strong>:
      </p>
      <div style="margin:18px 0;padding:18px;border-radius:12px;background:#f8fafc;border:1px solid #cbd5e1;text-align:center">
        <div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:32px;font-weight:800;letter-spacing:0.22em;color:#0f172a">${code}</div>
        <div style="margin-top:6px;font-size:12px;color:#64748b">Expires in 5 minutes · Single-use only</div>
      </div>
      <table style="width:100%;font-size:13px;color:#334155;border-collapse:collapse">
        <tr><td style="padding:4px 0;color:#64748b">Device Label:</td><td style="padding:4px 0;font-weight:600">${deviceName}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b">Browser / OS:</td><td style="padding:4px 0">${userAgentSummary}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b">Primary Owner:</td><td style="padding:4px 0">${PRIMARY_OWNER_EMAIL}</td></tr>
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#64748b;line-height:1.5">
        If you did not initiate or approve this access request, do not share this code.
      </p>
    </div>
  `;

  // 1. Resend API
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    try {
      const from =
        (process.env.RESEND_FROM || '').trim() ||
        'Presenza Security <onboarding@resend.dev>';
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [PRIMARY_OWNER_EMAIL],
          subject,
          text: textBody,
          html: htmlBody,
        }),
      });
      if (resp.ok) {
        return {
          delivered: true,
          provider: 'resend',
          note: `A 6-digit verification code has been emailed to ${PRIMARY_OWNER_EMAIL}.`,
        };
      }
      const errText = await resp.text();
      console.error('Resend email delivery error:', resp.status, errText);
    } catch (err) {
      console.error('Resend request failed:', err);
    }
  }

  // 2. Nodemailer SMTP (supports Gmail App Password or custom SMTP)
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  if (smtpUser && smtpPass) {
    try {
      const smtpHost = (process.env.SMTP_HOST || '').trim() || 'smtp.gmail.com';
      const smtpPort = Number(process.env.SMTP_PORT) || 465;
      const secure = smtpPort === 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      const from = (process.env.SMTP_FROM || '').trim() || smtpUser;
      await transporter.sendMail({
        from,
        to: PRIMARY_OWNER_EMAIL,
        subject,
        text: textBody,
        html: htmlBody,
      });

      return {
        delivered: true,
        provider: 'smtp',
        note: `A 6-digit verification code has been emailed to ${PRIMARY_OWNER_EMAIL}.`,
      };
    } catch (err) {
      console.error('SMTP email delivery failed:', err instanceof Error ? err.message : err);
      return {
        delivered: false,
        provider: 'smtp',
        note: `Request recorded, but email delivery failed. Check SMTP settings or ask the owner (${PRIMARY_OWNER_EMAIL}) to approve this device from their Owner Console.`,
      };
    }
  }

  return {
    delivered: false,
    provider: 'none',
    note: `Verification request created. Email delivery is not yet configured on the server; ask ${PRIMARY_OWNER_EMAIL} to approve this request or generate a code in their Owner Console.`,
  };
}

// Firebase Auth RS256 ID Token Verification via Google X.509 Public Certificates
interface CachedCerts {
  certs: Record<string, string>;
  expiresAtMs: number;
}
let certsCache: CachedCerts | null = null;

async function getFirebasePublicCerts(
  forceRefresh = false
): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && certsCache && now < certsCache.expiresAtMs) {
    return certsCache.certs;
  }

  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch Firebase public certificates (${resp.status}).`);
  }
  const certs = (await resp.json()) as Record<string, string>;
  const cacheControl = resp.headers.get('cache-control') || '';
  const match = /max-age=(\d+)/i.exec(cacheControl);
  const maxAgeSec = match ? Math.max(60, Number(match[1])) : 3600;

  certsCache = {
    certs,
    expiresAtMs: now + maxAgeSec * 1000,
  };
  return certs;
}

interface VerifiedOwnerClaims {
  uid: string;
  email: string;
}

async function verifyOwnerFirebaseIdToken(
  req: Request
): Promise<VerifiedOwnerClaims | null> {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = segments;

  try {
    const header = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf8')
    ) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) return null;

    let certs = await getFirebasePublicCerts(false);
    let pem = certs[header.kid];
    if (!pem) {
      certs = await getFirebasePublicCerts(true);
      pem = certs[header.kid];
    }
    if (!pem) return null;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const sigBuffer = Buffer.from(sigB64, 'base64url');
    if (!verifier.verify(pem, sigBuffer)) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as {
      aud?: unknown;
      iss?: unknown;
      sub?: unknown;
      exp?: unknown;
      iat?: unknown;
      email?: unknown;
      email_verified?: unknown;
    };

    const nowSec = Math.floor(Date.now() / 1000);
    const expectedIss = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
    if (payload.aud !== FIREBASE_PROJECT_ID || payload.iss !== expectedIss) {
      return null;
    }
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 60) return null;
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) return null;
    if (payload.email_verified !== true) return null;
    if (
      typeof payload.email !== 'string' ||
      payload.email.trim().toLowerCase() !== PRIMARY_OWNER_EMAIL
    ) {
      return null;
    }

    return {
      uid: payload.sub,
      email: payload.email.trim().toLowerCase(),
    };
  } catch (err) {
    console.warn('Owner token verification error:', err);
    return null;
  }
}

export function registerDeviceAuthRoutes(app: import('express').Express): void {
  // 1. Check current device authorization status
  app.post('/api/device-auth/status', (req, res) => {
    const store = loadStore();
    const token = extractDeviceTokenFromRequest(req);
    const verified = token ? verifySignedDeviceToken(store, token) : null;

    if (!verified) {
      res.json({
        authorized: false,
        revoked: false,
        policy: store.policy,
      });
      return;
    }

    const device = store.devices[verified.deviceId];
    if (!device) {
      clearDeviceTokenCookie(req, res);
      res.json({
        authorized: false,
        revoked: false,
        policy: store.policy,
      });
      return;
    }

    if (device.status === 'revoked') {
      clearDeviceTokenCookie(req, res);
      res.json({
        authorized: false,
        revoked: true,
        policy: store.policy,
      });
      return;
    }

    // Update lastSeenAt throttled (at most every 5 minutes)
    const lastMs = Date.parse(device.lastSeenAtIso) || 0;
    if (Date.now() - lastMs > 5 * 60 * 1000) {
      device.lastSeenAtIso = new Date().toISOString();
      saveStore(store);
    }

    res.json({
      authorized: true,
      revoked: false,
      device,
      policy: store.policy,
    });
  });

  // 2. Request a temporary 5-minute single-use verification code (sent only to owner email)
  app.post('/api/device-auth/request-code', async (req, res) => {
    const body = (req.body ?? {}) as {
      deviceId?: unknown;
      deviceName?: unknown;
    };
    const deviceId = sanitizeDeviceId(body.deviceId);
    if (!deviceId) {
      res.status(400).json({ error: 'Valid device identifier is required.' });
      return;
    }

    const store = loadStore();
    const now = Date.now();
    const ipKey = getClientIpKey(req);

    // Check active lockout
    const deviceLockUntil = store.lockouts[`dev:${deviceId}`] ?? 0;
    const ipLockUntil = store.lockouts[`ip:${ipKey}`] ?? 0;
    const lockUntil = Math.max(deviceLockUntil, ipLockUntil);
    if (lockUntil > now) {
      const waitMin = Math.ceil((lockUntil - now) / 60000);
      res.status(429).json({
        error: `Too many failed verification attempts. Please wait ${waitMin} minute(s) before requesting a new code.`,
      });
      return;
    }

    // Enforce cooldown & 15-minute sliding window
    const reqKey = `req:${deviceId}`;
    const recent = (store.requestTimestamps[reqKey] ?? []).filter(
      (ts) => ts > now - 15 * 60 * 1000
    );
    if (recent.length > 0 && now - recent[recent.length - 1] < REQUEST_COOLDOWN_MS) {
      const waitSec = Math.ceil(
        (REQUEST_COOLDOWN_MS - (now - recent[recent.length - 1])) / 1000
      );
      res.status(429).json({
        error: `Please wait ${waitSec} seconds before requesting another verification code.`,
      });
      return;
    }
    if (recent.length >= MAX_REQUESTS_PER_15M) {
      res.status(429).json({
        error: 'Code request limit reached for this device. Please try again in 15 minutes.',
      });
      return;
    }

    const userAgentSummary = summarizeUserAgent(req);
    const deviceName = sanitizeDeviceName(body.deviceName, userAgentSummary);

    // Invalidate any prior pending challenges for this device so only latest code works
    for (const ch of Object.values(store.challenges)) {
      if (ch.targetDeviceId === deviceId && !ch.used) {
        ch.used = true;
      }
    }

    const challengeId = `ch_${crypto.randomBytes(12).toString('hex')}`;
    const code = crypto.randomInt(100000, 1000000).toString();
    const secret = getSigningSecret(store);
    const codeHash = hashVerificationCode(secret, challengeId, code);
    const expiresAtMs = now + CODE_TTL_MS;
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    const emailResult = await sendOwnerVerificationEmail({
      code,
      deviceName,
      userAgentSummary,
      expiresAtIso,
    });

    store.challenges[challengeId] = {
      challengeId,
      targetDeviceId: deviceId,
      deviceName,
      userAgentSummary,
      codeHash,
      expiresAtMs,
      createdAtMs: now,
      attempts: 0,
      maxAttempts: MAX_WRONG_ATTEMPTS,
      used: false,
      emailSent: emailResult.delivered,
    };

    recent.push(now);
    store.requestTimestamps[reqKey] = recent;
    saveStore(store);

    // NEVER return the plaintext code to the unauthorized client
    res.json({
      ok: true,
      challengeId,
      expiresAtIso,
      emailSent: emailResult.delivered,
      emailProvider: emailResult.provider,
      deliveryNote: emailResult.note,
    });
  });

  // 3. Verify 6-digit code entered on the unauthorized device
  app.post('/api/device-auth/verify-code', (req, res) => {
    const body = (req.body ?? {}) as {
      deviceId?: unknown;
      challengeId?: unknown;
      code?: unknown;
      deviceName?: unknown;
    };

    const deviceId = sanitizeDeviceId(body.deviceId);
    if (!deviceId) {
      res.status(400).json({ error: 'Valid device identifier is required.' });
      return;
    }

    const rawCode = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(rawCode)) {
      res.status(400).json({ error: 'Please enter the 6-digit verification code.' });
      return;
    }

    const store = loadStore();
    const now = Date.now();
    const ipKey = getClientIpKey(req);

    const deviceLockUntil = store.lockouts[`dev:${deviceId}`] ?? 0;
    const ipLockUntil = store.lockouts[`ip:${ipKey}`] ?? 0;
    const lockUntil = Math.max(deviceLockUntil, ipLockUntil);
    if (lockUntil > now) {
      const waitMin = Math.ceil((lockUntil - now) / 60000);
      res.status(429).json({
        error: `Verification temporarily locked due to too many failed attempts. Try again in ${waitMin} minute(s).`,
      });
      return;
    }

    const secret = getSigningSecret(store);
    const requestedChallengeId =
      typeof body.challengeId === 'string' ? body.challengeId.trim() : '';

    // Find matching active challenge: either bound to this deviceId or an owner-generated invite ('*')
    const candidates = Object.values(store.challenges)
      .filter((ch) => {
        if (ch.used) return false;
        if (ch.expiresAtMs <= now) return false;
        if (ch.attempts >= ch.maxAttempts) return false;
        if (requestedChallengeId && ch.challengeId === requestedChallengeId) {
          return ch.targetDeviceId === deviceId || ch.targetDeviceId === '*';
        }
        return ch.targetDeviceId === deviceId || ch.targetDeviceId === '*';
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    if (candidates.length === 0) {
      res.status(400).json({
        error:
          'No active verification code found or the code has expired (5-minute limit). Please request a new code.',
      });
      return;
    }

    let matchedChallenge: StoredChallenge | null = null;
    for (const ch of candidates) {
      const expectedHash = hashVerificationCode(secret, ch.challengeId, rawCode);
      if (timingSafeHexEqual(expectedHash, ch.codeHash)) {
        matchedChallenge = ch;
        break;
      }
    }

    if (!matchedChallenge) {
      // Increment attempt counter on the primary active challenge for this device (or latest invite)
      const target =
        candidates.find((c) => c.targetDeviceId === deviceId) ?? candidates[0];
      target.attempts += 1;
      const remaining = Math.max(0, target.maxAttempts - target.attempts);
      if (remaining === 0) {
        target.used = true;
        store.lockouts[`dev:${deviceId}`] = now + VERIFY_LOCKOUT_MS;
        store.lockouts[`ip:${ipKey}`] = now + VERIFY_LOCKOUT_MS;
        saveStore(store);
        res.status(429).json({
          error:
            'Maximum verification attempts exceeded. This code has been invalidated and verification is locked for 10 minutes.',
        });
        return;
      }
      saveStore(store);
      res.status(401).json({
        error: `Invalid verification code. ${remaining} attempt(s) remaining before lockout.`,
      });
      return;
    }

    // Mark single-use immediately
    matchedChallenge.used = true;

    const userAgentSummary = summarizeUserAgent(req);
    const deviceName = sanitizeDeviceName(
      body.deviceName,
      matchedChallenge.deviceName || userAgentSummary
    );
    const nowIso = new Date(now).toISOString();

    const record: StoredDeviceRecord = {
      deviceId,
      deviceName,
      userAgentSummary,
      status: 'active',
      authorizedBy: 'code',
      authorizedAtIso: nowIso,
      lastSeenAtIso: nowIso,
    };
    store.devices[deviceId] = record;

    // Clear any leftover challenges for this device
    for (const ch of Object.values(store.challenges)) {
      if (ch.targetDeviceId === deviceId) {
        ch.used = true;
      }
    }

    const deviceToken = signDeviceToken(store, deviceId);
    saveStore(store);
    setDeviceTokenCookie(req, res, deviceToken);

    res.json({
      ok: true,
      authorized: true,
      message: 'Device successfully authenticated. Welcome!',
      deviceToken,
      device: record,
      policy: store.policy,
    });
  });

  // 4. Primary Owner Google Sign-In bootstrap: authorizes current device directly
  app.post('/api/device-auth/owner/authorize-current-device', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({
        error: `Only the verified primary owner (${PRIMARY_OWNER_EMAIL}) can authorize a device directly without a verification code.`,
      });
      return;
    }

    const body = (req.body ?? {}) as {
      deviceId?: unknown;
      deviceName?: unknown;
    };
    const deviceId = sanitizeDeviceId(body.deviceId);
    if (!deviceId) {
      res.status(400).json({ error: 'Valid device identifier is required.' });
      return;
    }

    const store = loadStore();
    const userAgentSummary = summarizeUserAgent(req);
    const deviceName = sanitizeDeviceName(body.deviceName, userAgentSummary);
    const nowIso = new Date().toISOString();

    const record: StoredDeviceRecord = {
      deviceId,
      deviceName,
      userAgentSummary,
      status: 'active',
      authorizedBy: 'owner-google',
      authorizedAtIso: nowIso,
      lastSeenAtIso: nowIso,
    };
    store.devices[deviceId] = record;

    const deviceToken = signDeviceToken(store, deviceId);
    saveStore(store);
    setDeviceTokenCookie(req, res, deviceToken);

    res.json({
      ok: true,
      authorized: true,
      message: 'Device successfully authenticated. Welcome!',
      deviceToken,
      device: record,
      policy: store.policy,
    });
  });

  // 5. Owner Console Overview (devices, pending requests, email status, policy)
  app.get('/api/device-auth/owner/overview', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({
        error: `Owner access restricted to ${PRIMARY_OWNER_EMAIL}.`,
      });
      return;
    }

    const store = loadStore();
    const now = Date.now();

    const devices = Object.values(store.devices).sort((a, b) =>
      b.lastSeenAtIso.localeCompare(a.lastSeenAtIso)
    );

    const pendingRequests = Object.values(store.challenges)
      .filter((ch) => !ch.used && ch.expiresAtMs > now && ch.targetDeviceId !== '*')
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((ch) => ({
        challengeId: ch.challengeId,
        deviceId: ch.targetDeviceId,
        deviceName: ch.deviceName,
        userAgentSummary: ch.userAgentSummary,
        expiresAtIso: new Date(ch.expiresAtMs).toISOString(),
        createdAtIso: new Date(ch.createdAtMs).toISOString(),
        attempts: ch.attempts,
        maxAttempts: ch.maxAttempts,
        emailSent: ch.emailSent,
      }));

    res.json({
      devices,
      pendingRequests,
      emailTransport: getEmailTransportStatus(),
      policy: store.policy,
      ownerEmail: PRIMARY_OWNER_EMAIL,
    });
  });

  // 6. Owner Console: Generate a 5-minute single-use code on demand (returns code ONLY to verified Primary Owner)
  app.post('/api/device-auth/owner/generate-code', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({ error: 'Primary owner authorization required.' });
      return;
    }

    const body = (req.body ?? {}) as {
      deviceName?: unknown;
      sendEmail?: unknown;
    };

    const store = loadStore();
    const now = Date.now();
    const challengeId = `ch_${crypto.randomBytes(12).toString('hex')}`;
    const code = crypto.randomInt(100000, 1000000).toString();
    const secret = getSigningSecret(store);
    const codeHash = hashVerificationCode(secret, challengeId, code);
    const expiresAtMs = now + CODE_TTL_MS;
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    const deviceName = sanitizeDeviceName(body.deviceName, 'New Device Invite');

    let emailSent = false;
    if (body.sendEmail === true) {
      const emailResult = await sendOwnerVerificationEmail({
        code,
        deviceName,
        userAgentSummary: 'Owner-generated invitation',
        expiresAtIso,
      });
      emailSent = emailResult.delivered;
    }

    store.challenges[challengeId] = {
      challengeId,
      targetDeviceId: '*',
      deviceName,
      userAgentSummary: 'Owner-generated invitation',
      codeHash,
      expiresAtMs,
      createdAtMs: now,
      attempts: 0,
      maxAttempts: MAX_WRONG_ATTEMPTS,
      used: false,
      emailSent,
    };
    saveStore(store);

    res.json({
      ok: true,
      challengeId,
      code,
      expiresAtIso,
      emailSent,
    });
  });

  // 7. Owner Console: Directly approve a pending device request
  app.post('/api/device-auth/owner/approve-request', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({ error: 'Primary owner authorization required.' });
      return;
    }

    const body = (req.body ?? {}) as {
      challengeId?: unknown;
      deviceId?: unknown;
    };
    const store = loadStore();
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId.trim() : '';
    const ch = store.challenges[challengeId];
    const deviceId = sanitizeDeviceId(ch?.targetDeviceId || body.deviceId);
    if (!deviceId) {
      res.status(400).json({ error: 'Valid pending device identifier is required.' });
      return;
    }

    if (ch) {
      ch.used = true;
      ch.directApproved = true;
      ch.directClaimed = false;
    }
    const nowIso = new Date().toISOString();
    const record: StoredDeviceRecord = {
      deviceId,
      deviceName: ch?.deviceName || 'Approved Device',
      userAgentSummary: ch?.userAgentSummary || 'Browser',
      status: 'active',
      authorizedBy: 'owner-direct',
      authorizedAtIso: nowIso,
      lastSeenAtIso: nowIso,
    };
    store.devices[deviceId] = record;
    saveStore(store);

    res.json({ ok: true, device: record });
  });

  // 8. Poll endpoint for pending device if owner clicked "Approve Device" directly in Owner Console
  app.post('/api/device-auth/poll-approval', (req, res) => {
    const body = (req.body ?? {}) as {
      deviceId?: unknown;
      challengeId?: unknown;
    };
    const deviceId = sanitizeDeviceId(body.deviceId);
    const challengeId =
      typeof body.challengeId === 'string' ? body.challengeId.trim() : '';
    if (!deviceId || !challengeId) {
      res.json({ approved: false });
      return;
    }

    const store = loadStore();
    const ch = store.challenges[challengeId];
    const device = store.devices[deviceId];
    if (
      !ch ||
      ch.targetDeviceId !== deviceId ||
      ch.directApproved !== true ||
      ch.directClaimed === true ||
      !device ||
      device.status !== 'active'
    ) {
      res.json({ approved: false });
      return;
    }

    ch.directClaimed = true;
    const deviceToken = signDeviceToken(store, deviceId);
    saveStore(store);
    setDeviceTokenCookie(req, res, deviceToken);
    res.json({
      approved: true,
      message: 'Device successfully authenticated. Welcome!',
      deviceToken,
      device,
      policy: store.policy,
    });
  });

  // 9. Owner Console: Revoke an authorized device
  app.post('/api/device-auth/owner/revoke', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({ error: 'Primary owner authorization required.' });
      return;
    }

    const body = (req.body ?? {}) as { deviceId?: unknown };
    const deviceId = sanitizeDeviceId(body.deviceId);
    if (!deviceId) {
      res.status(400).json({ error: 'Valid deviceId is required.' });
      return;
    }

    const store = loadStore();
    const existing = store.devices[deviceId];
    if (!existing) {
      res.status(404).json({ error: 'Device record not found.' });
      return;
    }

    existing.status = 'revoked';
    existing.revokedAtIso = new Date().toISOString();
    saveStore(store);

    res.json({ ok: true, device: existing });
  });

  // 10. Owner Console: Restore or permanently remove a device record
  app.post('/api/device-auth/owner/restore', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({ error: 'Primary owner authorization required.' });
      return;
    }

    const body = (req.body ?? {}) as { deviceId?: unknown; remove?: unknown };
    const deviceId = sanitizeDeviceId(body.deviceId);
    if (!deviceId) {
      res.status(400).json({ error: 'Valid deviceId is required.' });
      return;
    }

    const store = loadStore();
    if (body.remove === true) {
      delete store.devices[deviceId];
      saveStore(store);
      res.json({ ok: true, removed: true });
      return;
    }

    const existing = store.devices[deviceId];
    if (!existing) {
      res.status(404).json({ error: 'Device record not found.' });
      return;
    }

    existing.status = 'active';
    delete existing.revokedAtIso;
    existing.lastSeenAtIso = new Date().toISOString();
    saveStore(store);
    res.json({ ok: true, device: existing });
  });

  // 11. Owner Console: Update QR link security policy
  app.post('/api/device-auth/owner/policy', async (req, res) => {
    const owner = await verifyOwnerFirebaseIdToken(req);
    if (!owner) {
      res.status(403).json({ error: 'Primary owner authorization required.' });
      return;
    }

    const body = (req.body ?? {}) as { allowDirectQrWithoutDeviceAuth?: unknown };
    const store = loadStore();
    store.policy = {
      allowDirectQrWithoutDeviceAuth: Boolean(body.allowDirectQrWithoutDeviceAuth),
    };
    saveStore(store);
    res.json({ ok: true, policy: store.policy });
  });
}
