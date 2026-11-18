import type {
  AuthorizedDeviceRecord,
  DeviceSecurityPolicy,
  PendingDeviceChallengeSummary,
} from '../types';

const DEVICE_ID_STORAGE_KEY = 'presenza_device_id';
const DEVICE_TOKEN_STORAGE_KEY = 'presenza_device_token';

export function getOrCreateLocalDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_\-]{8,128}$/.test(existing)) {
      return existing;
    }
    const fresh =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `dev_${crypto.randomUUID().replace(/-/g, '')}`
        : `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function getStoredDeviceToken(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredDeviceToken(token: string): void {
  try {
    window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage quota / privacy mode errors; HttpOnly cookie remains active
  }
}

export function clearStoredDeviceToken(): void {
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getDefaultDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Browser Device';
  const ua = navigator.userAgent || '';
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  let os = 'Desktop';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/CrOS/i.test(ua)) os = 'Chromebook';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return `${browser} · ${os}`;
}

export class DeviceApiError extends Error {
  status: number;
  isApiUnavailable: boolean;

  constructor(message: string, status: number, isApiUnavailable = false) {
    super(message);
    this.name = 'DeviceApiError';
    this.status = status;
    this.isApiUnavailable = isApiUnavailable;
  }
}

async function parseJsonSafe<T>(resp: Response): Promise<T | null> {
  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return null;
  }
  try {
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export interface DeviceStatusResponse {
  authorized: boolean;
  revoked?: boolean;
  device?: AuthorizedDeviceRecord;
  policy?: DeviceSecurityPolicy;
}

export async function checkDeviceAuthStatus(): Promise<DeviceStatusResponse> {
  const token = getStoredDeviceToken();
  const resp = await fetch('/api/device-auth/status', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-device-token': token } : {}),
    },
    body: JSON.stringify({ deviceToken: token || undefined }),
  });

  const data = await parseJsonSafe<DeviceStatusResponse & { error?: string }>(resp);
  if (!resp.ok || !data) {
    const unavailable = resp.status === 404 || resp.status === 405 || !data;
    throw new DeviceApiError(
      data?.error || 'Unable to verify device authorization status.',
      resp.status,
      unavailable
    );
  }
  if (!data.authorized) {
    clearStoredDeviceToken();
  }
  return data;
}

export interface RequestCodeResponse {
  ok: boolean;
  challengeId: string;
  expiresAtIso: string;
  emailSent: boolean;
  emailProvider: 'resend' | 'smtp' | 'none';
  deliveryNote: string;
}

export async function requestOwnerVerificationCode(
  deviceId: string,
  deviceName: string
): Promise<RequestCodeResponse> {
  const resp = await fetch('/api/device-auth/request-code', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, deviceName }),
  });
  const data = await parseJsonSafe<RequestCodeResponse & { error?: string }>(resp);
  if (!resp.ok || !data) {
    const unavailable = resp.status === 404 || resp.status === 405 || !data;
    throw new DeviceApiError(
      data?.error || 'Failed to request verification code.',
      resp.status,
      unavailable
    );
  }
  return data;
}

export interface VerifyCodeResponse {
  ok: boolean;
  authorized: boolean;
  message: string;
  deviceToken: string;
  device: AuthorizedDeviceRecord;
  policy: DeviceSecurityPolicy;
}

export async function verifyDeviceCode(params: {
  deviceId: string;
  challengeId?: string | null;
  code: string;
  deviceName: string;
}): Promise<VerifyCodeResponse> {
  const resp = await fetch('/api/device-auth/verify-code', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await parseJsonSafe<VerifyCodeResponse & { error?: string }>(resp);
  if (!resp.ok || !data) {
    const unavailable = resp.status === 404 || resp.status === 405 || !data;
    throw new DeviceApiError(
      data?.error || 'Invalid verification code.',
      resp.status,
      unavailable
    );
  }
  if (data.deviceToken) {
    setStoredDeviceToken(data.deviceToken);
  }
  return data;
}

export async function pollDirectOwnerApproval(
  deviceId: string,
  challengeId: string
): Promise<{
  approved: boolean;
  message?: string;
  deviceToken?: string;
  device?: AuthorizedDeviceRecord;
}> {
  const resp = await fetch('/api/device-auth/poll-approval', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, challengeId }),
  });
  if (!resp.ok) return { approved: false };
  const data = await parseJsonSafe<{
    approved: boolean;
    message?: string;
    deviceToken?: string;
    device?: AuthorizedDeviceRecord;
  }>(resp);
  if (!data) return { approved: false };
  if (data.approved && data.deviceToken) {
    setStoredDeviceToken(data.deviceToken);
  }
  return data;
}

export async function authorizeCurrentDeviceAsOwner(
  idToken: string,
  deviceId: string,
  deviceName: string
): Promise<VerifyCodeResponse> {
  const resp = await fetch('/api/device-auth/owner/authorize-current-device', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ deviceId, deviceName }),
  });
  const data = await parseJsonSafe<VerifyCodeResponse & { error?: string }>(resp);
  if (!resp.ok || !data) {
    const unavailable = resp.status === 404 || resp.status === 405 || !data;
    throw new DeviceApiError(
      data?.error || 'Owner device authorization failed.',
      resp.status,
      unavailable
    );
  }
  if (data.deviceToken) {
    setStoredDeviceToken(data.deviceToken);
  }
  return data;
}

export interface OwnerDeviceOverview {
  devices: AuthorizedDeviceRecord[];
  pendingRequests: PendingDeviceChallengeSummary[];
  emailTransport: {
    configured: boolean;
    provider: 'resend' | 'smtp' | 'none';
  };
  policy: DeviceSecurityPolicy;
  ownerEmail: string;
}

export async function fetchOwnerDeviceOverview(
  idToken: string
): Promise<OwnerDeviceOverview> {
  const resp = await fetch('/api/device-auth/owner/overview', {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = await parseJsonSafe<OwnerDeviceOverview & { error?: string }>(resp);
  if (!resp.ok || !data) {
    throw new DeviceApiError(
      data?.error || 'Unable to load authorized devices.',
      resp.status,
      resp.status === 404 || resp.status === 405 || !data
    );
  }
  return data;
}

export async function generateOwnerInviteCode(
  idToken: string,
  deviceName: string,
  sendEmail: boolean
): Promise<{
  ok: boolean;
  challengeId: string;
  code: string;
  expiresAtIso: string;
  emailSent: boolean;
}> {
  const resp = await fetch('/api/device-auth/owner/generate-code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ deviceName, sendEmail }),
  });
  const data = await parseJsonSafe<{
    ok: boolean;
    challengeId: string;
    code: string;
    expiresAtIso: string;
    emailSent: boolean;
    error?: string;
  }>(resp);
  if (!resp.ok || !data) {
    throw new Error(data?.error || 'Unable to generate verification code.');
  }
  return data;
}

export async function approvePendingDeviceRequest(
  idToken: string,
  challengeId: string,
  deviceId: string
): Promise<AuthorizedDeviceRecord> {
  const resp = await fetch('/api/device-auth/owner/approve-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ challengeId, deviceId }),
  });
  const data = await parseJsonSafe<{
    ok: boolean;
    device: AuthorizedDeviceRecord;
    error?: string;
  }>(resp);
  if (!resp.ok || !data) {
    throw new Error(data?.error || 'Unable to approve device request.');
  }
  return data.device;
}

export async function revokeDeviceAccess(
  idToken: string,
  deviceId: string
): Promise<AuthorizedDeviceRecord> {
  const resp = await fetch('/api/device-auth/owner/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ deviceId }),
  });
  const data = await parseJsonSafe<{
    ok: boolean;
    device: AuthorizedDeviceRecord;
    error?: string;
  }>(resp);
  if (!resp.ok || !data) {
    throw new Error(data?.error || 'Unable to revoke device access.');
  }
  return data.device;
}

export async function restoreOrRemoveDeviceAccess(
  idToken: string,
  deviceId: string,
  remove = false
): Promise<{ device?: AuthorizedDeviceRecord; removed?: boolean }> {
  const resp = await fetch('/api/device-auth/owner/restore', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ deviceId, remove }),
  });
  const data = await parseJsonSafe<{
    ok: boolean;
    device?: AuthorizedDeviceRecord;
    removed?: boolean;
    error?: string;
  }>(resp);
  if (!resp.ok || !data) {
    throw new Error(data?.error || 'Unable to update device status.');
  }
  return data;
}

export async function updateDeviceSecurityPolicy(
  idToken: string,
  policy: DeviceSecurityPolicy
): Promise<DeviceSecurityPolicy> {
  const resp = await fetch('/api/device-auth/owner/policy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(policy),
  });
  const data = await parseJsonSafe<{
    ok: boolean;
    policy: DeviceSecurityPolicy;
    error?: string;
  }>(resp);
  if (!resp.ok || !data) {
    throw new Error(data?.error || 'Unable to update security policy.');
  }
  return data.policy;
}
