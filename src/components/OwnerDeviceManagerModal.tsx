import type { User } from 'firebase/auth';
import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  Mail,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { db } from '../firebase';
import type {
  AuthorizedDeviceRecord,
  DeviceSecurityPolicy,
  PendingDeviceChallengeSummary,
} from '../types';
import {
  approvePendingDeviceRequest,
  fetchOwnerDeviceOverview,
  generateOwnerInviteCode,
  getOrCreateLocalDeviceId,
  restoreOrRemoveDeviceAccess,
  revokeDeviceAccess,
  updateDeviceSecurityPolicy,
} from '../utils/deviceAuthClient';

interface OwnerDeviceManagerModalProps {
  user: User;
  onClose: () => void;
}

export default function OwnerDeviceManagerModal({
  user,
  onClose,
}: OwnerDeviceManagerModalProps) {
  const currentDeviceId = getOrCreateLocalDeviceId();
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<AuthorizedDeviceRecord[]>([]);
  const [pendingRequests, setPendingRequests] = useState<
    PendingDeviceChallengeSummary[]
  >([]);
  const [emailStatus, setEmailStatus] = useState<{
    configured: boolean;
    provider: 'resend' | 'smtp' | 'none';
  }>({ configured: false, provider: 'none' });
  const [policy, setPolicy] = useState<DeviceSecurityPolicy>({
    allowDirectQrWithoutDeviceAuth: false,
  });
  const [error, setError] = useState<string | null>(null);

  // Manual 5-minute invite code generator
  const [inviteLabel, setInviteLabel] = useState('Staff / Co-Admin Device');
  const [sendInviteEmail, setSendInviteEmail] = useState(false);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<{
    code: string;
    expiresAtIso: string;
    emailSent: boolean;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const syncDeviceToFirestore = useCallback(
    async (record: AuthorizedDeviceRecord) => {
      try {
        await setDoc(doc(db, 'authorizedDevices', record.deviceId), {
          ...record,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Non-blocking audit mirror; server store remains authoritative
      }
    },
    [user.uid]
  );

  const loadOverview = useCallback(async () => {
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const data = await fetchOwnerDeviceOverview(idToken);
      setDevices(data.devices);
      setPendingRequests(data.pendingRequests);
      setEmailStatus(data.emailTransport);
      setPolicy(data.policy);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to load device security data.'
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleGenerateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setGeneratingCode(true);
    try {
      const idToken = await user.getIdToken();
      const res = await generateOwnerInviteCode(
        idToken,
        inviteLabel.trim() || 'Authorized Device',
        sendInviteEmail
      );
      setGeneratedInvite({
        code: res.code,
        expiresAtIso: res.expiresAtIso,
        emailSent: res.emailSent,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to generate verification code.'
      );
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleCopyCode = async () => {
    if (!generatedInvite?.code) return;
    try {
      await navigator.clipboard.writeText(generatedInvite.code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleApprovePending = async (req: PendingDeviceChallengeSummary) => {
    setBusyId(req.challengeId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const device = await approvePendingDeviceRequest(
        idToken,
        req.challengeId,
        req.deviceId
      );
      await syncDeviceToFirestore(device);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (deviceId: string) => {
    setBusyId(deviceId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const updated = await revokeDeviceAccess(idToken, deviceId);
      await syncDeviceToFirestore(updated);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revocation failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleRestoreOrRemove = async (deviceId: string, remove: boolean) => {
    setBusyId(deviceId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await restoreOrRemoveDeviceAccess(idToken, deviceId, remove);
      if (remove) {
        try {
          await deleteDoc(doc(db, 'authorizedDevices', deviceId));
        } catch {
          // Ignore if doc did not exist in Firestore mirror
        }
      } else if (res.device) {
        await syncDeviceToFirestore(res.device);
      }
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleQrPolicy = async (allowDirect: boolean) => {
    setSavingPolicy(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const updated = await updateDeviceSecurityPolicy(idToken, {
        allowDirectQrWithoutDeviceAuth: allowDirect,
      });
      setPolicy(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update policy.');
    } finally {
      setSavingPolicy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="owner-devices-modal-title"
    >
      <div className="w-full max-w-3xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="owner-devices-modal-title"
                className="text-base sm:text-lg font-bold text-slate-900 truncate"
              >
                Cross-Device Access &amp; Revocation Control
              </h2>
              <p className="text-xs text-slate-500 truncate">
                Primary Owner: {user.email} · Verification codes expire in 5 minutes and are single-use
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadOverview()}
              className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              aria-label="Refresh devices"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              aria-label="Close device access modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
              {error}
            </div>
          )}

          {/* Email Delivery Configuration Indicator */}
          <div
            className={`rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs ${
              emailStatus.configured
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <Mail className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">
                  {emailStatus.configured
                    ? `Email Delivery Active (${emailStatus.provider.toUpperCase()})`
                    : 'Server Email Delivery Not Yet Configured'}
                </div>
                <p className="mt-0.5 opacity-90">
                  {emailStatus.configured
                    ? `Verification codes requested by new devices are automatically emailed to ${user.email}.`
                    : `Configure RESEND_API_KEY or SMTP_USER + SMTP_PASS in server environment variables to automatically email codes to ${user.email}. Until then, you can approve requests or generate codes directly below.`}
                </p>
              </div>
            </div>
          </div>

          {/* QR Access Policy Toggle */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-slate-900">
                QR Check-In &amp; Feedback Link Access Policy
              </div>
              <p className="text-xs text-slate-600 mt-0.5">
                Choose whether scanning an event QR link (<span className="font-mono-tabular">?event=...</span>) also requires device authorization or opens directly for workshop attendees.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 shrink-0 cursor-pointer">
              <input
                type="checkbox"
                disabled={savingPolicy}
                checked={policy.allowDirectQrWithoutDeviceAuth}
                onChange={(e) => void handleToggleQrPolicy(e.target.checked)}
                className="w-4 h-4 accent-blue-700 rounded"
              />
              <span className="text-xs font-semibold text-slate-800 whitespace-nowrap">
                Allow direct QR links
              </span>
            </label>
          </div>

          {/* Generate Owner Invite Code */}
          <form
            onSubmit={handleGenerateCode}
            className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
          >
            <div className="text-xs font-bold uppercase tracking-wide text-slate-800 flex items-center gap-1.5">
              <KeyRound className="w-4 h-4 text-blue-700" />
              <span>Generate 5-Minute Single-Use Verification Code</span>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                maxLength={80}
                value={inviteLabel}
                onChange={(e) => setInviteLabel(e.target.value)}
                placeholder="Target device label (e.g. Hall Projector)"
                className="flex-1 min-h-[40px] px-3 py-2 text-sm border border-slate-300 rounded-xl bg-slate-50 text-slate-900"
              />
              {emailStatus.configured && (
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={sendInviteEmail}
                    onChange={(e) => setSendInviteEmail(e.target.checked)}
                    className="w-4 h-4 accent-blue-700 rounded"
                  />
                  <span>Also email me</span>
                </label>
              )}
              <button
                type="submit"
                disabled={generatingCode}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-60"
              >
                {generatingCode ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <KeyRound className="w-3.5 h-3.5" />
                )}
                <span>Generate Code</span>
              </button>
            </div>

            {generatedInvite && (
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3.5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-blue-800">
                    Share this 5-minute single-use code:
                  </div>
                  <div className="mt-1 text-2xl font-mono-tabular font-extrabold tracking-[0.25em] text-slate-900">
                    {generatedInvite.code}
                  </div>
                  <div className="text-[11px] text-slate-600 mt-0.5">
                    Expires at{' '}
                    {new Date(generatedInvite.expiresAtIso).toLocaleTimeString()}
                    {generatedInvite.emailSent ? ' · Also emailed to you' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyCode()}
                  className="min-h-[36px] px-3 py-1.5 rounded-lg border border-blue-300 bg-white hover:bg-blue-50 text-xs font-semibold text-blue-900 inline-flex items-center gap-1.5"
                >
                  {copiedCode ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Code</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </form>

          {/* Pending Requests */}
          {pendingRequests.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase tracking-wide text-amber-800 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-amber-700" />
                <span>Pending Device Requests ({pendingRequests.length})</span>
              </div>

              <div className="divide-y divide-slate-100 rounded-xl border border-amber-200 bg-amber-50/30 overflow-hidden">
                {pendingRequests.map((req) => (
                  <div
                    key={req.challengeId}
                    className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900 truncate">
                        {req.deviceName}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {req.userAgentSummary} · Expires{' '}
                        {new Date(req.expiresAtIso).toLocaleTimeString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === req.challengeId}
                      onClick={() => void handleApprovePending(req)}
                      className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                    >
                      {busyId === req.challengeId ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      <span>Approve Device</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Authorized & Revoked Devices */}
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-700 flex items-center gap-1.5">
              <Laptop className="w-4 h-4 text-slate-600" />
              <span>Registered Devices ({devices.length})</span>
            </div>

            {loading ? (
              <div className="p-6 text-center text-xs text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-700" />
                Loading device registry...
              </div>
            ) : devices.length === 0 ? (
              <div className="rounded-xl border border-slate-200 p-6 text-center text-xs text-slate-500">
                No external devices authorized yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white overflow-hidden">
                {devices.map((dev) => {
                  const isCurrent = dev.deviceId === currentDeviceId;
                  const isRevoked = dev.status === 'revoked';
                  return (
                    <div
                      key={dev.deviceId}
                      className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-slate-900 truncate">
                            {dev.deviceName}
                          </span>
                          {isCurrent && (
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                              This Device
                            </span>
                          )}
                          <span
                            className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                              isRevoked
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            }`}
                          >
                            {isRevoked ? 'Revoked' : 'Authorized'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {dev.userAgentSummary} · Authorized via{' '}
                          {dev.authorizedBy === 'code'
                            ? 'Verification Code'
                            : dev.authorizedBy === 'owner-google'
                            ? 'Owner Sign-In'
                            : 'Owner Approval'}
                        </div>
                        <div className="text-[11px] font-mono-tabular text-slate-400">
                          Authorized:{' '}
                          {new Date(dev.authorizedAtIso).toLocaleString()} · Last seen:{' '}
                          {new Date(dev.lastSeenAtIso).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {!isRevoked ? (
                          isCurrent ? (
                            <span className="text-xs text-slate-400 font-medium">
                              Active session
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={busyId === dev.deviceId}
                              onClick={() => void handleRevoke(dev.deviceId)}
                              className="min-h-[34px] px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-xs font-semibold text-rose-700 inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              {busyId === dev.deviceId ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ShieldAlert className="w-3.5 h-3.5" />
                              )}
                              <span>Revoke Access</span>
                            </button>
                          )
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busyId === dev.deviceId}
                              onClick={() =>
                                void handleRestoreOrRemove(dev.deviceId, false)
                              }
                              className="min-h-[34px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Restore</span>
                            </button>
                            <button
                              type="button"
                              disabled={busyId === dev.deviceId}
                              onClick={() =>
                                void handleRestoreOrRemove(dev.deviceId, true)
                              }
                              className="min-h-[34px] px-2.5 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-xs font-semibold text-rose-700 inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
