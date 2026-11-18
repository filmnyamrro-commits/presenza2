import {
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  type User,
} from 'firebase/auth';
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  Mail,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  auth,
  type AuthErrorDetails,
  BOOTSTRAPPED_ADMIN_EMAIL,
  formatFirebaseAuthError,
  googleProvider,
  normalizeAdminEmail,
} from '../firebase';
import type { OrganizationBranding } from '../types';
import {
  authorizeCurrentDeviceAsOwner,
  checkDeviceAuthStatus,
  clearStoredDeviceToken,
  DeviceApiError,
  getDefaultDeviceLabel,
  getOrCreateLocalDeviceId,
  pollDirectOwnerApproval,
  requestOwnerVerificationCode,
  verifyDeviceCode,
} from '../utils/deviceAuthClient';

interface DeviceAuthGateProps {
  branding?: OrganizationBranding | null;
  isDirectQrLink: boolean;
  user: User | null;
  authReady: boolean;
  children: ReactNode;
}

function isPrimaryOwnerUser(u: User | null): boolean {
  return Boolean(
    u &&
      u.email &&
      u.emailVerified &&
      normalizeAdminEmail(u.email) === BOOTSTRAPPED_ADMIN_EMAIL
  );
}

function isEmbeddedInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export default function DeviceAuthGate({
  branding,
  isDirectQrLink,
  user,
  authReady,
  children,
}: DeviceAuthGateProps) {
  const deviceId = useMemo(() => getOrCreateLocalDeviceId(), []);
  const inIframe = useMemo(() => isEmbeddedInIframe(), []);

  const [deviceCheckDone, setDeviceCheckDone] = useState(false);
  const [status, setStatus] = useState<
    'checking' | 'unauthorized' | 'welcome' | 'authorized'
  >('checking');
  const [wasRevoked, setWasRevoked] = useState(false);

  const [deviceLabel, setDeviceLabel] = useState(getDefaultDeviceLabel);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [expiresAtMs, setExpiresAtMs] = useState<number | null>(null);
  const [remainingSec, setRemainingSec] = useState<number>(0);

  const [codeInput, setCodeInput] = useState('');
  const [requestingCode, setRequestingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [ownerSigningIn, setOwnerSigningIn] = useState(false);
  const [autoAuthorizingOwner, setAutoAuthorizingOwner] = useState(false);

  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ownerAuthError, setOwnerAuthError] = useState<AuthErrorDetails | null>(
    null
  );
  const [welcomeMessage, setWelcomeMessage] = useState<string>(
    'Device successfully authenticated. Welcome!'
  );

  const manualSignInInFlightRef = useRef(false);
  const autoAttemptedUidRef = useRef<string | null>(null);
  const userRef = useRef<User | null>(user);
  userRef.current = user;
  const authReadyRef = useRef<boolean>(authReady);
  authReadyRef.current = authReady;

  const authorizeVerifiedOwnerUser = useCallback(
    async (
      ownerUser: User,
      options: { showWelcomeScreen: boolean }
    ): Promise<boolean> => {
      const idToken = await ownerUser.getIdToken(true);
      const label = deviceLabel.trim() || getDefaultDeviceLabel();
      try {
        const res = await authorizeCurrentDeviceAsOwner(
          idToken,
          deviceId,
          label
        );
        setWasRevoked(false);
        setOwnerAuthError(null);
        setErrorMessage(null);
        setWelcomeMessage(
          res.message || 'Device successfully authenticated. Welcome!'
        );
        setStatus(options.showWelcomeScreen ? 'welcome' : 'authorized');
        return true;
      } catch (err) {
        if (err instanceof DeviceApiError && err.isApiUnavailable) {
          // Backend device-auth API unavailable (e.g. static hosting):
          // Firebase Auth already cryptographically verified the Primary Owner.
          setWasRevoked(false);
          setOwnerAuthError(null);
          setErrorMessage(null);
          setStatus(options.showWelcomeScreen ? 'welcome' : 'authorized');
          return true;
        }
        throw err;
      }
    },
    [deviceId, deviceLabel]
  );

  const performStatusCheck = useCallback(
    async (silent = false) => {
      if (!silent) {
        setStatus('checking');
      }
      try {
        const res = await checkDeviceAuthStatus();
        if (
          res.authorized ||
          (isDirectQrLink && res.policy?.allowDirectQrWithoutDeviceAuth)
        ) {
          setWasRevoked(false);
          setStatus('authorized');
          setDeviceCheckDone(true);
          return;
        }
        if (res.revoked) {
          setWasRevoked(true);
        }
        setDeviceCheckDone(true);
        setStatus((prev) => {
          if (prev === 'welcome') return 'welcome';
          // Wait for authReady before revealing the unauthorized screen so an active
          // Primary Owner session can auto-authorize seamlessly without flashing a lock screen.
          if (!authReadyRef.current) return 'checking';
          if (isPrimaryOwnerUser(userRef.current) && !res.revoked) {
            return 'checking';
          }
          return 'unauthorized';
        });
      } catch (err) {
        setDeviceCheckDone(true);
        if (
          err instanceof DeviceApiError &&
          err.isApiUnavailable &&
          isPrimaryOwnerUser(userRef.current)
        ) {
          setStatus('authorized');
          return;
        }
        setStatus((prev) => {
          if (prev === 'authorized') return 'authorized';
          if (!authReadyRef.current) return 'checking';
          return 'unauthorized';
        });
      }
    },
    [isDirectQrLink]
  );

  useEffect(() => {
    void performStatusCheck(false);
  }, [performStatusCheck]);

  // Pick up Google OAuth redirect result if signInWithRedirect was used
  useEffect(() => {
    let active = true;
    async function checkRedirect() {
      try {
        const cred = await getRedirectResult(auth);
        if (!active || !cred?.user) return;
        if (!isPrimaryOwnerUser(cred.user)) {
          clearStoredDeviceToken();
          setOwnerAuthError({
            code: 'auth/owner-only',
            title: 'Not Primary Owner Account',
            message: `Signed in as ${cred.user.email || 'unknown account'}. Only the primary owner (${BOOTSTRAPPED_ADMIN_EMAIL}) can authorize a new device directly. Please request a verification code from the owner.`,
          });
          setStatus('unauthorized');
          return;
        }
        setAutoAuthorizingOwner(true);
        await authorizeVerifiedOwnerUser(cred.user, {
          showWelcomeScreen: true,
        });
      } catch (err) {
        if (!active) return;
        const formatted = formatFirebaseAuthError(err);
        setOwnerAuthError(formatted);
        setStatus('unauthorized');
      } finally {
        if (active) {
          setAutoAuthorizingOwner(false);
        }
      }
    }
    void checkRedirect();
    return () => {
      active = false;
    };
  }, [authorizeVerifiedOwnerUser]);

  // Automatic Primary Owner Login: if Firebase Auth already holds a verified
  // rohantmr.lover@gmail.com session (and this device wasn't explicitly revoked),
  // automatically authorize this device and log the owner in with zero clicks.
  useEffect(() => {
    if (!authReady || !deviceCheckDone) return;
    if (status === 'authorized' || status === 'welcome') return;
    if (manualSignInInFlightRef.current) return;

    if (!user || !isPrimaryOwnerUser(user)) {
      if (status === 'checking') {
        setStatus('unauthorized');
      }
      return;
    }

    if (wasRevoked) {
      if (status === 'checking') {
        setStatus('unauthorized');
      }
      return;
    }

    if (autoAttemptedUidRef.current === user.uid) {
      if (status === 'checking') {
        setStatus('unauthorized');
      }
      return;
    }

    let cancelled = false;
    autoAttemptedUidRef.current = user.uid;
    setAutoAuthorizingOwner(true);

    void (async () => {
      try {
        await authorizeVerifiedOwnerUser(user, { showWelcomeScreen: false });
      } catch (err) {
        if (cancelled) return;
        setOwnerAuthError({
          code: 'device-auth/auto-login-failed',
          title: 'Automatic Owner Sign-In Needs Retry',
          message:
            err instanceof Error
              ? err.message
              : 'Could not complete automatic owner device authorization.',
        });
        setStatus('unauthorized');
      } finally {
        if (!cancelled) {
          setAutoAuthorizingOwner(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authReady,
    deviceCheckDone,
    status,
    user,
    wasRevoked,
    authorizeVerifiedOwnerUser,
  ]);

  // Periodic background verification so revoked devices lose access promptly
  useEffect(() => {
    if (status !== 'authorized') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void performStatusCheck(true);
      }
    };
    const interval = window.setInterval(() => {
      void performStatusCheck(true);
    }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, performStatusCheck]);

  // Live 5-minute countdown timer
  useEffect(() => {
    if (!expiresAtMs) {
      setRemainingSec(0);
      return;
    }
    const tick = () => {
      const diff = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
      setRemainingSec(diff);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAtMs]);

  // Poll for direct owner approval when a challenge is active
  useEffect(() => {
    if (status !== 'unauthorized' || !challengeId || remainingSec <= 0) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await pollDirectOwnerApproval(deviceId, challengeId);
        if (res.approved) {
          setWelcomeMessage(
            res.message || 'Device successfully authenticated. Welcome!'
          );
          setStatus('welcome');
        }
      } catch {
        // Ignore poll error
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [status, challengeId, remainingSec, deviceId]);

  // Auto-enter app smoothly after showing the welcome confirmation message
  useEffect(() => {
    if (status !== 'welcome') return;
    const timer = window.setTimeout(() => {
      setStatus('authorized');
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [status]);

  const handleRequestCode = async () => {
    setErrorMessage(null);
    setOwnerAuthError(null);
    setDeliveryNotice(null);
    setRequestingCode(true);
    try {
      const res = await requestOwnerVerificationCode(
        deviceId,
        deviceLabel.trim() || getDefaultDeviceLabel()
      );
      setChallengeId(res.challengeId);
      setExpiresAtMs(Date.parse(res.expiresAtIso) || Date.now() + 5 * 60 * 1000);
      setEmailSent(res.emailSent);
      setDeliveryNotice(res.deliveryNote);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not request authentication code.'
      );
    } finally {
      setRequestingCode(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = codeInput.replace(/\D/g, '').slice(0, 6);
    if (cleaned.length !== 6) {
      setErrorMessage('Please enter the 6-digit verification code from the owner.');
      return;
    }
    setErrorMessage(null);
    setOwnerAuthError(null);
    setVerifyingCode(true);
    try {
      const res = await verifyDeviceCode({
        deviceId,
        challengeId,
        code: cleaned,
        deviceName: deviceLabel.trim() || getDefaultDeviceLabel(),
      });
      setWasRevoked(false);
      setWelcomeMessage(
        res.message || 'Device successfully authenticated. Welcome!'
      );
      setStatus('welcome');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Verification failed. Please check the code.'
      );
    } finally {
      setVerifyingCode(false);
    }
  };

  const handleOwnerBootstrapSignIn = async () => {
    setErrorMessage(null);
    setOwnerAuthError(null);
    setOwnerSigningIn(true);
    manualSignInInFlightRef.current = true;

    try {
      // If Firebase Auth already holds a verified Primary Owner session,
      // authorize this device immediately without even forcing another Google popup.
      const existingOwner = auth.currentUser;
      if (existingOwner && isPrimaryOwnerUser(existingOwner)) {
        await authorizeVerifiedOwnerUser(existingOwner, {
          showWelcomeScreen: true,
        });
        return;
      }

      const cred = await signInWithPopup(auth, googleProvider);
      if (!isPrimaryOwnerUser(cred.user)) {
        clearStoredDeviceToken();
        setOwnerAuthError({
          code: 'auth/owner-only',
          title: 'Primary Owner Account Required',
          message: `Signed in as ${cred.user.email || 'unknown account'}. Only the primary owner (${BOOTSTRAPPED_ADMIN_EMAIL}) can authorize a new device directly. Please request a verification code from the owner.`,
        });
        return;
      }

      await authorizeVerifiedOwnerUser(cred.user, {
        showWelcomeScreen: true,
      });
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';

      if (
        !inIframe &&
        (code === 'auth/popup-blocked' ||
          code === 'auth/operation-not-supported-in-this-environment')
      ) {
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectErr) {
          setOwnerAuthError(formatFirebaseAuthError(redirectErr));
          return;
        }
      }

      setOwnerAuthError(formatFirebaseAuthError(err));
    } finally {
      manualSignInInFlightRef.current = false;
      setOwnerSigningIn(false);
    }
  };

  const handleOwnerRedirectSignIn = async () => {
    setErrorMessage(null);
    setOwnerAuthError(null);
    setOwnerSigningIn(true);
    try {
      await signInWithRedirect(auth, googleProvider);
    } catch (err) {
      setOwnerAuthError(formatFirebaseAuthError(err));
      setOwnerSigningIn(false);
    }
  };

  if (status === 'authorized') {
    return <>{children}</>;
  }

  const orgName = branding?.organizationName?.trim() || '';
  const logoUrl = branding?.logoDataUrl || '';
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;

  if (status === 'checking' || autoAuthorizingOwner) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-700" />
        <p className="mt-3 text-sm font-medium text-slate-600">
          {autoAuthorizingOwner
            ? 'Signing in primary owner automatically...'
            : 'Verifying device authorization...'}
        </p>
      </div>
    );
  }

  if (status === 'welcome') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md bg-white border border-emerald-200 rounded-2xl p-8 text-center shadow-lg space-y-5">
          <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">
              {orgName ? `${orgName} · PRESENZA` : 'PRESENZA'}
            </div>
            <h1 className="text-xl sm:text-2xl font-display font-bold text-slate-900">
              {welcomeMessage}
            </h1>
            <p className="text-xs text-slate-600">
              This device is now remembered and authorized for future sessions until revoked by the owner.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setStatus('authorized')}
            className="w-full min-h-[46px] px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold transition-colors"
          >
            Continue to Application
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
        {/* Top Security Header */}
        <div className="px-6 sm:px-8 pt-7 pb-5 border-b border-slate-100 text-center space-y-3">
          <div className="flex items-center justify-center gap-3">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={orgName ? `${orgName} logo` : 'Organization logo'}
                className="h-11 w-11 rounded-xl object-contain bg-white border border-slate-200 p-1"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6" />
              </div>
            )}
          </div>

          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-blue-700">
              {orgName ? `${orgName} · PRESENZA` : 'PRESENZA'}
            </div>
            <h1 className="mt-1 text-xl sm:text-2xl font-display font-bold text-slate-900">
              Device Authorization Required
            </h1>
            <p className="mt-2 text-sm text-slate-700 leading-relaxed">
              This device is not yet authorized. Please request an authentication code from the application owner.
            </p>
          </div>

          {wasRevoked && (
            <div
              role="alert"
              className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-start gap-2 text-left"
            >
              <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <span>
                This device&apos;s previous authorization was revoked by the owner. Request and enter a new verification code (or sign in as primary owner) to regain access.
              </span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="p-6 sm:p-8 space-y-5">
          {/* Step 1: Request Code */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-800">
                <Laptop className="w-4 h-4 text-blue-700" />
                <span>Step 1 · Request Owner Code</span>
              </div>
              {remainingSec > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-mono-tabular font-semibold text-blue-700">
                  <Timer className="w-3.5 h-3.5" />
                  <span>
                    {String(mins).padStart(2, '0')}:
                    {String(secs).padStart(2, '0')}
                  </span>
                </span>
              )}
            </div>

            <div>
              <label
                htmlFor="device-label-input"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Device Name (helps owner identify this screen)
              </label>
              <input
                id="device-label-input"
                type="text"
                maxLength={80}
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="e.g. Auditorium Projector Laptop"
                className="w-full min-h-[42px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <button
              type="button"
              disabled={requestingCode}
              onClick={() => void handleRequestCode()}
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-blue-300 bg-blue-50 hover:bg-blue-100 text-blue-900 text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {requestingCode ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4 text-blue-700" />
              )}
              <span>
                {challengeId
                  ? 'Resend Verification Code to Owner'
                  : 'Request Verification Code'}
              </span>
            </button>

            {deliveryNotice && (
              <div
                className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${
                  emailSent
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-blue-200 bg-white text-slate-700'
                }`}
              >
                {deliveryNotice}
              </div>
            )}
          </div>

          {/* Step 2: Enter Verification Code */}
          <form onSubmit={handleVerifyCode} className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-800">
              <KeyRound className="w-4 h-4 text-slate-700" />
              <span>Step 2 · Enter 6-Digit Verification Code</span>
            </div>

            <input
              id="device-code-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={codeInput}
              onChange={(e) =>
                setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
              placeholder="000000"
              aria-label="6-digit verification code"
              className="w-full min-h-[54px] px-4 py-2.5 text-center text-2xl font-mono-tabular font-bold tracking-[0.35em] bg-white border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />

            {errorMessage && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800"
              >
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={verifyingCode || codeInput.replace(/\D/g, '').length !== 6}
              className="w-full min-h-[46px] px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {verifyingCode ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ShieldCheck className="w-4 h-4" />
              )}
              <span>
                {verifyingCode ? 'Verifying Code...' : 'Verify & Authorize Device'}
              </span>
            </button>
          </form>

          {/* Primary Owner Google Auth Option */}
          <div className="pt-4 border-t border-slate-200 space-y-2.5 text-center">
            <p className="text-xs text-slate-500">
              Primary owner (<span className="font-semibold text-slate-700">{BOOTSTRAPPED_ADMIN_EMAIL}</span>)? Sign in with Google to authorize automatically:
            </p>

            {ownerAuthError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-900 text-left space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-rose-950">
                    {ownerAuthError.title}
                  </span>
                  <span className="text-[10px] font-mono text-rose-700">
                    {ownerAuthError.code}
                  </span>
                </div>
                <p className="leading-relaxed text-rose-800">
                  {ownerAuthError.message}
                </p>
                {ownerAuthError.helpSteps &&
                  ownerAuthError.helpSteps.length > 0 && (
                    <ol className="list-decimal pl-4 space-y-1 text-rose-800 pt-1">
                      {ownerAuthError.helpSteps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ol>
                  )}
              </div>
            )}

            <button
              type="button"
              disabled={ownerSigningIn}
              onClick={() => void handleOwnerBootstrapSignIn()}
              className="w-full min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {ownerSigningIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Sign in as Primary Owner</span>
            </button>

            {(ownerAuthError || inIframe) && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {inIframe && typeof window !== 'undefined' && (
                  <a
                    href={window.location.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 text-xs font-semibold transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open in New Tab to Sign In</span>
                  </a>
                )}
                {!inIframe && (
                  <button
                    type="button"
                    disabled={ownerSigningIn}
                    onClick={() => void handleOwnerRedirectSignIn()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition-colors disabled:opacity-60"
                  >
                    <span>Use Google Redirect Sign-In</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
