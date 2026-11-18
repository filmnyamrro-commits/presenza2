import {
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  ImagePlus,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Printer,
  Users,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttendanceRecord, EventRecord, OrganizationBranding } from '../types';

interface QrPosterModalProps {
  event: EventRecord;
  eventAttendances: AttendanceRecord[];
  onClose: () => void;
  onOpenCheckIn: (eventId: string) => void;
  onOpenFeedback?: (eventId: string) => void;
  onLaunchProjector?: (eventId: string) => void;
  onPreviewPhoto: (record: AttendanceRecord) => void;
  dashboardBgUrl?: string | null;
  dashboardBgOpacity?: number;
  savingBg?: boolean;
  bgError?: string | null;
  onUploadBackground?: (file: File) => Promise<void>;
  onChangeBackgroundOpacity?: (opacity: number) => void;
  onRemoveBackground?: () => Promise<void>;
  branding?: OrganizationBranding | null;
}

export default function QrPosterModal({
  event,
  eventAttendances,
  onClose,
  onOpenCheckIn,
  onOpenFeedback,
  onLaunchProjector,
  onPreviewPhoto,
  dashboardBgUrl,
  dashboardBgOpacity = 25,
  savingBg = false,
  bgError,
  onUploadBackground,
  onChangeBackgroundOpacity,
  onRemoveBackground,
  branding,
}: QrPosterModalProps) {
  const [qrMode, setQrMode] = useState<'checkin' | 'feedback'>('checkin');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);

  const checkInUrl = `${window.location.origin}/?event=${encodeURIComponent(event.id)}`;
  const feedbackUrl = `${window.location.origin}/?view=feedback&event=${encodeURIComponent(event.id)}`;
  const activeQrUrl = qrMode === 'feedback' ? feedbackUrl : checkInUrl;

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(activeQrUrl, {
      width: 640,
      margin: 2,
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch((err) => {
        console.error('QR generation error:', err);
      });
    return () => {
      active = false;
    };
  }, [activeQrUrl]);

  const counts = useMemo(() => {
    const total = eventAttendances.length;
    const onTime = eventAttendances.filter((a) => a.status === 'On Time').length;
    const late = eventAttendances.filter((a) => a.status === 'Late').length;
    return { total, onTime, late };
  }, [eventAttendances]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeQrUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  const handleDownloadPng = () => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.href = qrDataUrl;
    const suffix = qrMode === 'feedback' ? 'feedback-qr' : 'checkin-qr';
    link.download = `${event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-sm p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <div
        className={`w-full bg-white border border-slate-200 shadow-2xl overflow-hidden flex flex-col transition-all ${
          expanded
            ? 'max-w-[96vw] h-[94vh] rounded-2xl'
            : 'max-w-5xl max-h-[92vh] rounded-2xl'
        }`}
      >
        {/* Top Modal Header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-slate-200 shrink-0 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {branding?.logoDataUrl && (
              <img
                src={branding.logoDataUrl}
                alt={branding.organizationName ? `${branding.organizationName} logo` : 'Organization logo'}
                className="h-10 w-10 rounded-lg object-contain bg-white border border-slate-200 p-0.5 shrink-0"
              />
            )}
            <div className="min-w-0">
              {branding?.organizationName && (
                <div className="text-[11px] font-bold uppercase tracking-wider text-blue-700 truncate">
                  {branding.organizationName} · PRESENZA
                </div>
              )}
              <h2
                id="qr-modal-title"
                className="text-lg font-bold text-slate-900 truncate"
              >
                {event.title}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{event.category}</span>
                <span aria-hidden="true">·</span>
                <span>{event.venue}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">{event.eventDate}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">
                  Start {event.startTime} (Cutoff {event.lateCutoffTime})
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {onLaunchProjector && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onLaunchProjector(event.id);
                }}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <MonitorPlay className="w-4 h-4" />
                <span>Animated Projector</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 transition-colors hidden sm:inline-flex items-center gap-1.5"
              aria-label={expanded ? 'Exit expanded view' : 'Expand projector view'}
            >
              {expanded ? (
                <>
                  <Minimize2 className="w-4 h-4" />
                  <span>Compact</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-4 h-4" />
                  <span>Expand</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
              aria-label="Close QR and live attendance board"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Side-by-Side Split: Left QR Code Poster | Right Live Clock-In Dashboard */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-y-auto lg:overflow-hidden">
          {/* Left Column: QR Code & Sharing Actions */}
          <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col justify-between bg-slate-50/50">
            <div className="px-5 pt-4 flex justify-center">
              <div
                className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1"
                role="tablist"
                aria-label="QR Code Mode"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={qrMode === 'checkin'}
                  onClick={() => setQrMode('checkin')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    qrMode === 'checkin'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Check-In QR
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={qrMode === 'feedback'}
                  onClick={() => setQrMode('feedback')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    qrMode === 'feedback'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Feedback QR
                </button>
              </div>
            </div>

            <div
              id="qr-print-sheet"
              className="px-6 py-5 flex flex-col items-center text-center"
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                {branding?.organizationName ? `${branding.organizationName} · PRESENZA` : 'PRESENZA'}
              </div>
              <h3 className="mt-1 text-lg font-bold text-slate-900 text-balance max-w-sm">
                {qrMode === 'feedback'
                  ? 'Scan to Submit Feedback & Evaluation'
                  : 'Scan to Clock In'}
              </h3>

              <div className="mt-4 p-4 rounded-2xl border border-slate-200 bg-white shadow-sm">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={`${qrMode === 'feedback' ? 'Feedback' : 'Check-in'} QR Code for ${event.title}`}
                    className="w-48 h-48 sm:w-52 sm:h-52 object-contain"
                  />
                ) : (
                  <div className="w-48 h-48 sm:w-52 sm:h-52 flex items-center justify-center bg-slate-50 text-xs text-slate-400">
                    Generating QR code...
                  </div>
                )}
              </div>

              <p className="mt-3 text-xs text-slate-600 max-w-xs leading-relaxed">
                {qrMode === 'feedback'
                  ? 'No login needed. Participants rate the session, tick quick feedback statements, and share written recommendations.'
                  : 'No login or account needed. Scan with your phone camera, fill in name & class, take a photo, and submit.'}
              </p>
            </div>

            <div className="px-5 py-4 bg-white border-t border-slate-200 space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={activeQrUrl}
                  aria-label="Direct QR URL"
                  className="flex-1 min-w-0 px-3 py-2 text-xs font-mono-tabular bg-slate-50 border border-slate-200 rounded-lg text-slate-700"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={handleDownloadPng}
                  disabled={!qrDataUrl}
                  className="min-h-[40px] px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Save PNG</span>
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="min-h-[40px] px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    if (qrMode === 'feedback' && onOpenFeedback) {
                      onOpenFeedback(event.id);
                    } else {
                      onOpenCheckIn(event.id);
                    }
                  }}
                  className="min-h-[40px] px-2.5 py-2 rounded-xl bg-blue-700 text-xs font-semibold text-white hover:bg-blue-800 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open Form</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Live Clock-In Dashboard Next to the QR Code */}
          <div className="lg:col-span-7 relative flex flex-col min-h-[320px] lg:min-h-0 bg-white overflow-hidden">
            {dashboardBgUrl && (
              <img
                src={dashboardBgUrl}
                alt=""
                aria-hidden="true"
                style={{ opacity: Math.min(1, Math.max(0, dashboardBgOpacity / 100)) }}
                className="absolute inset-0 w-full h-full object-cover object-top pointer-events-none select-none transition-opacity duration-150"
              />
            )}

            {onUploadBackground && (
              <input
                ref={bgFileInputRef}
                type="file"
                accept="image/jpeg,.jpg,.jpeg"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void onUploadBackground(file);
                }}
                className="hidden"
                aria-label="Upload JPEG portrait background"
              />
            )}

            <div className="relative z-10 flex flex-col flex-1 min-h-0">
              <div
                className={`px-5 sm:px-6 py-4 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-3 shrink-0 ${
                  dashboardBgUrl ? 'bg-white/80 backdrop-blur-[2px]' : ''
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-slate-900">
                      Live Clock-In Dashboard
                    </h3>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
                      <span
                        className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
                        aria-hidden="true"
                      />
                      <span>Live</span>
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Participants appear here automatically as they scan the QR code
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2.5 text-xs font-mono-tabular mr-1">
                    <span className="font-semibold text-slate-900">
                      {counts.total} Total
                    </span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span className="font-semibold text-emerald-700">
                      {counts.onTime} On Time
                    </span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span className="font-semibold text-amber-700">
                      {counts.late} Late
                    </span>
                  </div>

                  {onUploadBackground && (
                    <button
                      type="button"
                      disabled={savingBg}
                      onClick={() => bgFileInputRef.current?.click()}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                    >
                      {savingBg ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ImagePlus className="w-3.5 h-3.5 text-blue-700" />
                      )}
                      <span>{dashboardBgUrl ? 'Change JPEG Bg' : 'JPEG Portrait Bg'}</span>
                    </button>
                  )}
                  {dashboardBgUrl && onChangeBackgroundOpacity && (
                    <label className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-[11px] font-semibold text-slate-700 inline-flex items-center gap-2">
                      <span>Opacity</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={dashboardBgOpacity}
                        onChange={(e) =>
                          onChangeBackgroundOpacity(Number(e.target.value))
                        }
                        aria-label="Live dashboard background photo opacity"
                        className="w-16 accent-blue-700 cursor-pointer"
                      />
                      <span className="font-mono-tabular w-8 text-right">
                        {dashboardBgOpacity}%
                      </span>
                    </label>
                  )}
                  {dashboardBgUrl && onRemoveBackground && (
                    <button
                      type="button"
                      disabled={savingBg}
                      onClick={() => void onRemoveBackground()}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-xs font-semibold text-rose-700 transition-colors whitespace-nowrap disabled:opacity-50"
                    >
                      Clear Bg
                    </button>
                  )}
                </div>
              </div>

              {bgError && (
                <div className="px-5 py-2 text-xs text-rose-700 bg-rose-50 border-b border-rose-200">
                  {bgError}
                </div>
              )}

              {eventAttendances.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="w-12 h-12 rounded-xl bg-white/90 border border-slate-200 text-slate-500 flex items-center justify-center mb-3">
                    <Users className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-semibold text-slate-900">
                    Waiting for participants to clock in
                  </p>
                  <p className="text-xs text-slate-600 mt-1 max-w-xs">
                    When someone scans the QR code on the left and submits attendance, their photo, name, class, time, and status will appear here instantly.
                  </p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto divide-y divide-slate-200/70">
                  <AnimatePresence initial={false}>
                    {eventAttendances.map((rec, index) => {
                      const serverMs = rec.serverTimestamp?.toMillis?.() ?? 0;
                      const isRecent =
                        serverMs > 0 && Date.now() - serverMs < 120_000;
                      return (
                        <motion.div
                          key={rec.id}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className={`px-5 sm:px-6 py-3.5 flex items-center justify-between gap-4 ${
                            isRecent
                              ? 'bg-blue-50/75'
                              : dashboardBgUrl
                              ? 'bg-white/55 hover:bg-white/80'
                              : 'hover:bg-slate-50/70'
                          }`}
                        >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-7 text-xs font-mono-tabular font-semibold text-slate-400 shrink-0">
                            #{index + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => onPreviewPhoto(rec)}
                            className="w-12 h-12 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shrink-0 hover:ring-2 hover:ring-blue-600 transition-all"
                            aria-label={`View photo of ${rec.fullName}`}
                          >
                            <img
                              src={rec.photoDataUrl}
                              alt={rec.fullName}
                              className="w-full h-full object-cover"
                            />
                          </button>

                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-slate-900 truncate">
                                {rec.fullName}
                              </span>
                              {isRecent && (
                                <span className="text-[11px] font-semibold text-blue-700 shrink-0">
                                  New
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-600 truncate mt-0.5">
                              {rec.classDepartment}
                            </div>
                            {rec.status === 'Late' && rec.lateExcuse && (
                              <div className="text-xs text-amber-800 mt-0.5 line-clamp-2">
                                Excuse: {rec.lateExcuse}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-4 shrink-0">
                          <div className="text-right">
                            <div className="font-mono-tabular text-xs font-semibold text-slate-900">
                              {rec.checkInTime}
                            </div>
                            <div className="font-mono-tabular text-[11px] text-slate-500">
                              {rec.attendanceDate}
                            </div>
                          </div>

                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold border whitespace-nowrap ${
                              rec.status === 'On Time'
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                : 'bg-amber-50 text-amber-800 border-amber-200'
                            }`}
                          >
                            {rec.status === 'On Time' ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 text-amber-700" />
                            )}
                            <span>{rec.status}</span>
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
