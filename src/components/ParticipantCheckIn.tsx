import {
  Camera,
  CheckCircle2,
  Clock,
  FlipHorizontal2,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  Volume2,
  AlertCircle,
} from 'lucide-react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import {
  auth,
  type AuthErrorDetails,
  db,
  formatFirebaseAuthError,
  googleProvider,
  handleFirestoreError,
  normalizeAdminEmail,
} from '../firebase';
import {
  type CheckInReceipt,
  type EventRecord,
  OperationType,
  type VoiceAnnouncementSettings,
} from '../types';
import {
  buildCutoffDate,
  evaluateAttendanceStatus,
  formatClockTime,
  formatLocalDateYmd,
  generateSafeId,
} from '../utils/dateTime';
import { captureVideoFrame, compressImageFile } from '../utils/imageCompress';
import {
  DEFAULT_VOICE_SETTINGS,
  formatAnnouncementMessage,
  mergeVoiceSettings,
  speakAnnouncement,
  stopAllAnnouncements,
  unlockBrowserAudio,
} from '../utils/voiceAnnouncement';

interface ParticipantCheckInProps {
  requestedEventId: string | null;
  user?: User | null;
  onSelectEventId: (eventId: string | null) => void;
  onGoToFeedback?: (eventId: string) => void;
  onGoToAdmin?: () => void;
}

export default function ParticipantCheckIn({
  requestedEventId,
  user = null,
  onSelectEventId,
  onGoToFeedback,
  onGoToAdmin,
}: ParticipantCheckInProps) {
  const [activeEvents, setActiveEvents] = useState<EventRecord[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventError, setEventError] = useState<string | null>(null);

  const [now, setNow] = useState<Date>(() => new Date());

  // Form fields
  const [fullName, setFullName] = useState('');
  const [classDepartment, setClassDepartment] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [photoConsent, setPhotoConsent] = useState(false);
  const [lateExcuse, setLateExcuse] = useState('');

  // Optional participant Google sign-in state (when event requires email login)
  const [signingInParticipant, setSigningInParticipant] = useState(false);
  const [participantAuthError, setParticipantAuthError] =
    useState<AuthErrorDetails | null>(null);

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('user');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [processingPhoto, setProcessingPhoto] = useState(false);

  // Submit & receipt state
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CheckInReceipt | null>(null);

  // Voice announcement settings
  const [voiceSettings, setVoiceSettings] =
    useState<VoiceAnnouncementSettings>(DEFAULT_VOICE_SETTINGS);
  const [speakingReceipt, setSpeakingReceipt] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);

  // Load saved Voice Announcement Settings
  useEffect(() => {
    const unsubVoice = onSnapshot(
      doc(db, 'voiceSettings', 'default'),
      (snap) => {
        if (snap.exists()) {
          setVoiceSettings(
            mergeVoiceSettings(
              snap.data() as Partial<VoiceAnnouncementSettings>
            )
          );
        } else {
          setVoiceSettings(DEFAULT_VOICE_SETTINGS);
        }
      },
      () => {
        setVoiceSettings(DEFAULT_VOICE_SETTINGS);
      }
    );
    return () => {
      unsubVoice();
      stopAllAnnouncements();
    };
  }, []);

  // Live 1-second clock tick for accurate check-in time display
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Subscribe to active events
  useEffect(() => {
    setLoadingEvents(true);
    const eventsQuery = query(
      collection(db, 'events'),
      where('status', '==', 'active')
    );

    const unsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        const list: EventRecord[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<EventRecord, 'id'>),
        }));
        list.sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() ?? 0;
          const bTime = b.createdAt?.toMillis?.() ?? 0;
          return bTime - aTime;
        });
        setActiveEvents(list);
        setLoadingEvents(false);
      },
      (error) => {
        setLoadingEvents(false);
        handleFirestoreError(error, OperationType.LIST, 'events');
      }
    );

    return () => unsubscribe();
  }, []);

  // Resolve requestedEventId or default to first active event
  useEffect(() => {
    let cancelled = false;

    async function resolveEvent() {
      setEventError(null);
      if (requestedEventId) {
        const match = activeEvents.find((ev) => ev.id === requestedEventId);
        if (match) {
          setSelectedEvent(match);
          return;
        }
        // Try direct get if not yet in activeEvents (e.g. closed or invalid)
        try {
          const snap = await getDoc(doc(db, 'events', requestedEventId));
          if (cancelled) return;
          if (!snap.exists()) {
            setSelectedEvent(null);
            setEventError(
              'This QR code session was not found or has ended. Select an active session below if available.'
            );
          } else {
            const data = snap.data() as Omit<EventRecord, 'id'>;
            if (data.status !== 'active') {
              setSelectedEvent(null);
              setEventError(
                'Check-in for this session has been closed by the administrator.'
              );
            } else {
              setSelectedEvent({ id: snap.id, ...data });
            }
          }
        } catch {
          if (!cancelled) {
            setSelectedEvent(null);
            setEventError(
              'This session is no longer accepting check-ins or could not be loaded.'
            );
          }
        }
      } else {
        setSelectedEvent(activeEvents[0] ?? null);
      }
    }

    if (!loadingEvents) {
      void resolveEvent();
    }

    return () => {
      cancelled = true;
    };
  }, [requestedEventId, activeEvents, loadingEvents]);

  // Camera stream lifecycle
  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  const startCamera = async (facing: 'user' | 'environment') => {
    setCameraError(null);
    stopCameraStream();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Live camera preview is unavailable in this browser. Use "Use native phone camera app" below.'
      );
      setCameraOpen(false);
      return;
    }

    try {
      setCameraOpen(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 960 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      setCameraOpen(false);
      stopCameraStream();
      const message =
        err instanceof Error ? err.message : 'Camera permission was denied.';
      setCameraError(
        `Unable to open live camera (${message}). Please allow camera access or use your phone's native camera button below.`
      );
    }
  };

  const handleToggleFacing = () => {
    const next = cameraFacing === 'user' ? 'environment' : 'user';
    setCameraFacing(next);
    void startCamera(next);
  };

  const handleCaptureSnapshot = () => {
    if (!videoRef.current) return;
    try {
      setProcessingPhoto(true);
      const dataUrl = captureVideoFrame(
        videoRef.current,
        cameraFacing === 'user'
      );
      setPhotoDataUrl(dataUrl);
      setCameraOpen(false);
      stopCameraStream();
      setFormError(null);
    } catch (err) {
      setCameraError(
        err instanceof Error ? err.message : 'Could not capture photo.'
      );
    } finally {
      setProcessingPhoto(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCameraError(null);
    setFormError(null);
    setProcessingPhoto(true);
    try {
      const compressed = await compressImageFile(file);
      setPhotoDataUrl(compressed);
      setCameraOpen(false);
      stopCameraStream();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Unable to process selected photo.'
      );
    } finally {
      setProcessingPhoto(false);
    }
  };

  // Compute live automatic attendance metadata
  const cutoffDate = selectedEvent
    ? selectedEvent.cutoffTimestamp?.toDate
      ? selectedEvent.cutoffTimestamp.toDate()
      : buildCutoffDate(selectedEvent.eventDate, selectedEvent.lateCutoffTime)
    : null;

  const liveStatus = cutoffDate ? evaluateAttendanceStatus(now, cutoffDate) : 'On Time';
  const liveDateStr = formatLocalDateYmd(now);
  const liveTimeStr = formatClockTime(now);

  const requiresParticipantLogin = Boolean(selectedEvent?.requireParticipantLogin);
  const participantVerifiedEmail =
    user && user.email && user.emailVerified
      ? normalizeAdminEmail(user.email)
      : '';

  useEffect(() => {
    if (
      requiresParticipantLogin &&
      user?.displayName &&
      !fullName.trim()
    ) {
      setFullName(user.displayName.trim().slice(0, 100));
    }
  }, [requiresParticipantLogin, user?.displayName, fullName]);

  const handleParticipantGoogleSignIn = async () => {
    setParticipantAuthError(null);
    setSigningInParticipant(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (cred.user?.displayName && !fullName.trim()) {
        setFullName(cred.user.displayName.trim().slice(0, 100));
      }
    } catch (err: unknown) {
      setParticipantAuthError(formatFirebaseAuthError(err));
    } finally {
      setSigningInParticipant(false);
    }
  };

  const handleParticipantSignOut = async () => {
    setParticipantAuthError(null);
    try {
      await signOut(auth);
    } catch (err: unknown) {
      setParticipantAuthError(formatFirebaseAuthError(err));
    }
  };

  const customDepartmentLabel =
    selectedEvent?.departmentLabel?.trim() || 'Class / Department';
  const customConsentText =
    selectedEvent?.consentText?.trim() ||
    'I consent to the use of my submitted photo for PRESENZA verification and official professional development attendance records.';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!selectedEvent) {
      setFormError('No active workshop or seminar session is selected.');
      return;
    }
    if (requiresParticipantLogin && (!user || !participantVerifiedEmail)) {
      setFormError(
        'This session requires you to sign in with your Google email before submitting check-in.'
      );
      return;
    }

    const cleanName = fullName.trim();
    const cleanDept = classDepartment.trim();

    if (cleanName.length < 2) {
      setFormError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (cleanDept.length < 1) {
      setFormError(`Please enter your ${customDepartmentLabel.toLowerCase()}.`);
      return;
    }
    if (!photoDataUrl) {
      setFormError('Please take a picture using your camera.');
      return;
    }
    if (!photoConsent) {
      setFormError('Please check the photo consent box before submitting.');
      return;
    }

    setSubmitting(true);
    const submitMoment = new Date();
    const attendanceDate = formatLocalDateYmd(submitMoment);
    const checkInTime = formatClockTime(submitMoment);
    const eventCutoff = selectedEvent.cutoffTimestamp?.toDate
      ? selectedEvent.cutoffTimestamp.toDate()
      : buildCutoffDate(selectedEvent.eventDate, selectedEvent.lateCutoffTime);
    const computedStatus = evaluateAttendanceStatus(submitMoment, eventCutoff);
    const cleanExcuse = lateExcuse.trim().slice(0, 300);

    if (computedStatus === 'Late' && cleanExcuse.length < 3) {
      setSubmitting(false);
      setFormError(
        'You are checking in after the cutoff time. Please type your excuse for being late before submitting.'
      );
      return;
    }

    const attendanceId = generateSafeId('att');
    const finalExcuse = computedStatus === 'Late' ? cleanExcuse : '';

    const payload: Record<string, unknown> = {
      eventId: selectedEvent.id,
      eventName: selectedEvent.title,
      fullName: cleanName.slice(0, 100),
      classDepartment: cleanDept.slice(0, 100),
      photoDataUrl,
      photoConsent: true,
      attendanceDate,
      checkInTime,
      serverTimestamp: serverTimestamp(),
      status: computedStatus,
      lateExcuse: finalExcuse,
    };

    if (requiresParticipantLogin && user && participantVerifiedEmail) {
      payload.participantEmail = participantVerifiedEmail.slice(0, 128);
      payload.participantUid = user.uid;
    }

    try {
      await setDoc(doc(db, 'attendances', attendanceId), payload);

      try {
        window.localStorage.setItem(
          `presenza_last_checkin_${selectedEvent.id}`,
          JSON.stringify({
            attendanceId,
            fullName: cleanName,
            classDepartment: cleanDept,
            participantEmail:
              requiresParticipantLogin && participantVerifiedEmail
                ? participantVerifiedEmail
                : '',
          })
        );
      } catch {
        // Ignore storage quota restrictions cleanly
      }

      setReceipt({
        id: attendanceId,
        eventId: selectedEvent.id,
        eventName: selectedEvent.title,
        fullName: cleanName,
        classDepartment: cleanDept,
        photoDataUrl,
        attendanceDate,
        checkInTime,
        recordedAtIso: submitMoment.toISOString(),
        status: computedStatus,
        lateExcuse: finalExcuse,
        participantEmail:
          requiresParticipantLogin && participantVerifiedEmail
            ? participantVerifiedEmail
            : undefined,
      });

      if (voiceSettings.enabled && voiceSettings.announceOnCheckIn) {
        unlockBrowserAudio();
        const announcementText = formatAnnouncementMessage(voiceSettings, {
          name: cleanName,
          department: cleanDept,
          eventTitle: selectedEvent.title,
        });
        if (announcementText) {
          setSpeakingReceipt(true);
          void speakAnnouncement(announcementText, voiceSettings).finally(() => {
            setSpeakingReceipt(false);
          });
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.toLowerCase().includes('permission')) {
        setFormError(
          'Unable to record attendance. This session may have closed or requires verified Google email login.'
        );
      } else {
        setFormError('Network error while submitting attendance. Please try again.');
      }
      try {
        handleFirestoreError(
          error,
          OperationType.CREATE,
          `attendances/${attendanceId}`
        );
      } catch {
        // Error already logged for diagnostics; friendly message displayed in UI
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetForNext = () => {
    setReceipt(null);
    setFullName('');
    setClassDepartment('');
    setPhotoDataUrl(null);
    setPhotoConsent(false);
    setLateExcuse('');
    setFormError(null);
    setCameraError(null);
    stopCameraStream();
    setCameraOpen(false);
  };

  // Confirmation Receipt Screen
  if (receipt) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-6 py-6 sm:px-8 border-b border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
                  Attendance Recorded
                </h1>
                <p className="text-sm text-slate-600 mt-0.5">
                  Thank you, {receipt.fullName}. Your check-in has been saved with a verified server timestamp.
                </p>
              </div>
            </div>

            <div
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap shrink-0 ${
                receipt.status === 'On Time'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-amber-50 text-amber-800 border border-amber-200'
              }`}
            >
              {receipt.status === 'On Time' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700" />
              ) : (
                <Clock className="w-4 h-4 text-amber-700" />
              )}
              <span>{receipt.status}</span>
            </div>
          </div>

          <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-12 gap-6 items-start">
            <div className="sm:col-span-4">
              <div className="aspect-square rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
                <img
                  src={receipt.photoDataUrl}
                  alt={`${receipt.fullName} check-in verification`}
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="text-xs text-slate-500 mt-2 text-center">
                Photo consent recorded
              </p>
            </div>

            <dl className="sm:col-span-8 divide-y divide-slate-100 text-sm">
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Full Name</dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {receipt.fullName}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Class / Department</dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {receipt.classDepartment}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Event Name</dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {receipt.eventName}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Attendance Date</dt>
                <dd className="font-mono-tabular font-medium text-slate-900 text-right">
                  {receipt.attendanceDate}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Exact Check-In Time</dt>
                <dd className="font-mono-tabular font-medium text-slate-900 text-right">
                  {receipt.checkInTime}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Server Timestamp</dt>
                <dd className="font-mono-tabular text-xs text-slate-700 text-right">
                  Verified ({receipt.recordedAtIso.slice(0, 19).replace('T', ' ')} UTC)
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Attendance Status</dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {receipt.status}
                </dd>
              </div>
              {receipt.participantEmail && (
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Verified Email</dt>
                  <dd className="font-medium text-slate-900 text-right break-all">
                    {receipt.participantEmail}
                  </dd>
                </div>
              )}
              {receipt.status === 'Late' && receipt.lateExcuse && (
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500 shrink-0">Late Excuse</dt>
                  <dd className="text-slate-800 text-right break-words max-w-xs">
                    {receipt.lateExcuse}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <div className="px-6 py-4 sm:px-8 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {receipt.participantEmail
                ? 'Verified email recorded. You may close this page now.'
                : 'No account or email required. You may close this page now.'}
            </span>
            <div className="w-full sm:w-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              {voiceSettings.enabled && (
                <button
                  type="button"
                  onClick={() => {
                    unlockBrowserAudio();
                    const text = formatAnnouncementMessage(voiceSettings, {
                      name: receipt.fullName,
                      department: receipt.classDepartment,
                      eventTitle: receipt.eventName,
                    });
                    if (text) {
                      setSpeakingReceipt(true);
                      void speakAnnouncement(text, voiceSettings).finally(() => {
                        setSpeakingReceipt(false);
                      });
                    }
                  }}
                  disabled={speakingReceipt}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 text-sm font-semibold transition-colors flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-70"
                >
                  <Volume2 className="w-4 h-4" />
                  <span>
                    {speakingReceipt ? 'Announcing...' : 'Replay Welcome Voice'}
                  </span>
                </button>
              )}
              {onGoToFeedback && (
                <button
                  type="button"
                  onClick={() => onGoToFeedback(receipt.eventId)}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>Give Session Feedback</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleResetForNext}
                className="min-h-[44px] px-5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-800 hover:bg-slate-100 transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Check In Another Participant</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
      {/* Notice if URL points to a closed/unknown event or no active sessions exist */}
      {eventError && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm text-amber-900"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <span>{eventError}</span>
          </div>
          {activeEvents.length > 0 && (
            <button
              type="button"
              onClick={() => onSelectEventId(activeEvents[0].id)}
              className="min-h-[40px] px-3.5 py-2 rounded-lg bg-amber-900 text-white text-xs font-semibold hover:bg-amber-800 transition-colors whitespace-nowrap shrink-0"
            >
              Switch to Active Session
            </button>
          )}
        </div>
      )}

      {!loadingEvents && activeEvents.length === 0 && !selectedEvent && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-bold text-slate-900">
              No active session is currently open
            </h2>
            <p className="text-sm text-slate-600">
              {onGoToAdmin
                ? 'Sign in as an administrator to customize the attendance form, open a session, and share its QR code.'
                : 'Please scan a valid event QR code or wait for your session organizer to open check-in.'}
            </p>
          </div>
          {onGoToAdmin && (
            <button
              type="button"
              onClick={onGoToAdmin}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
            >
              Admin Sign In &amp; Customize
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
        {/* Left Column: Session Information & Live Automatic Telemetry */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div>
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-blue-700">
              <span>INSTANT QR CHECK-IN</span>
              <span>
                {requiresParticipantLogin
                  ? 'EMAIL LOGIN REQUIRED'
                  : 'NO LOGIN REQUIRED'}
              </span>
            </div>

            {loadingEvents ? (
              <div className="mt-3 space-y-2 animate-pulse">
                <div className="h-7 bg-slate-200 rounded w-3/4" />
                <div className="h-4 bg-slate-100 rounded w-1/2" />
              </div>
            ) : selectedEvent ? (
              <>
                <h1 className="mt-2 text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight text-balance">
                  {selectedEvent.title}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>{selectedEvent.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" />
                    {selectedEvent.venue}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{selectedEvent.eventDate}</span>
                </div>
                {selectedEvent.description && (
                  <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                    {selectedEvent.description}
                  </p>
                )}
              </>
            ) : (
              <div className="mt-2">
                <h1 className="text-2xl font-bold text-slate-900">
                  PRESENZA
                </h1>
                <p className="mt-1.5 text-sm text-slate-600">
                  Scan an event QR code or select an open workshop session to record your attendance immediately.
                </p>
              </div>
            )}
          </div>

          {/* Session Switcher if multiple active sessions exist and not strictly locked or user wants to switch */}
          {activeEvents.length > 1 && (
            <div className="pt-4 border-t border-slate-100">
              <label
                htmlFor="session-select"
                className="block text-xs font-semibold text-slate-600 mb-1.5"
              >
                Active Session ({activeEvents.length} open)
              </label>
              <select
                id="session-select"
                value={selectedEvent?.id ?? ''}
                onChange={(e) => onSelectEventId(e.target.value || null)}
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {activeEvents.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title} ({ev.eventDate})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Live Automatic Metadata Panel */}
          <div className="pt-5 border-t border-slate-100 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">
                Recorded Automatically
              </span>
              {selectedEvent && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold ${
                    liveStatus === 'On Time'
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                      : 'bg-amber-50 text-amber-800 border border-amber-200'
                  }`}
                >
                  {liveStatus === 'On Time' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 text-amber-700" />
                  )}
                  <span>{liveStatus}</span>
                </span>
              )}
            </div>

            <dl className="divide-y divide-slate-100 text-sm">
              <div className="py-2.5 flex items-center justify-between gap-3">
                <dt className="text-slate-500">Attendance Date</dt>
                <dd className="font-mono-tabular font-medium text-slate-900">
                  {liveDateStr}
                </dd>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-3">
                <dt className="text-slate-500">Exact Check-In Time</dt>
                <dd className="font-mono-tabular font-semibold text-slate-900">
                  {liveTimeStr}
                </dd>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-3">
                <dt className="text-slate-500">Late Cutoff</dt>
                <dd className="font-mono-tabular text-slate-700">
                  {selectedEvent ? selectedEvent.lateCutoffTime : '—'}
                </dd>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-3">
                <dt className="text-slate-500">Server Timestamp</dt>
                <dd className="text-xs font-medium text-slate-700">
                  Synced on submit
                </dd>
              </div>
            </dl>
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-start gap-2.5 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>
              {requiresParticipantLogin
                ? 'This session requires signing in with a Google email before submitting attendance.'
                : 'No sign-up, account, email address, or password is required to mark attendance.'}
            </span>
          </div>
        </section>

        {/* Right Column: Participant Attendance Form */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 sm:p-8">
          <div className="mb-6">
            <h2 className="text-xl font-bold text-slate-900">
              Participant Check-In Form
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              {requiresParticipantLogin
                ? 'Verify your Google email, complete the three fields below, and confirm photo consent to submit.'
                : 'Complete the three fields below and confirm photo consent to submit your attendance.'}
            </p>
          </div>

          {requiresParticipantLogin && (
            <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50/60 p-4 space-y-3">
              {participantVerifiedEmail ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                      <Mail className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-500">
                        Verified Participant Email
                      </div>
                      <div className="text-sm font-bold text-slate-900 truncate">
                        {participantVerifiedEmail}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleParticipantSignOut()}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap self-start sm:self-auto"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Switch Account</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-2.5">
                    <Mail className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-slate-900">
                        Google Email Required for This Session
                      </p>
                      <p className="text-xs text-slate-600 mt-0.5">
                        The organizer enabled email verification for this session. Sign in with your Google account to unlock submission.
                      </p>
                    </div>
                  </div>

                  {participantAuthError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 space-y-1"
                    >
                      <p className="font-semibold">{participantAuthError.title}</p>
                      <p>{participantAuthError.message}</p>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleParticipantGoogleSignIn()}
                    disabled={signingInParticipant}
                    className="w-full sm:w-auto min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {signingInParticipant ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Mail className="w-4 h-4" />
                    )}
                    <span>
                      {signingInParticipant
                        ? 'Signing in...'
                        : 'Sign in with Google'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6" noValidate>
            {/* 1. Full Name */}
            <div>
              <label
                htmlFor="full-name"
                className="block text-sm font-semibold text-slate-900 mb-2"
              >
                1. Full Name <span className="text-rose-600">*</span>
              </label>
              <input
                id="full-name"
                name="fullName"
                type="text"
                autoComplete="name"
                required
                maxLength={100}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Sarah Jenkins"
                className="w-full min-h-[48px] px-4 py-3 text-base bg-white border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            {/* 2. Class / Department (free-text entry with customizable label) */}
            <div>
              <label
                htmlFor="class-department"
                className="block text-sm font-semibold text-slate-900 mb-2"
              >
                2. {customDepartmentLabel} <span className="text-rose-600">*</span>
              </label>
              <input
                id="class-department"
                name="classDepartment"
                type="text"
                required
                maxLength={100}
                value={classDepartment}
                onChange={(e) => setClassDepartment(e.target.value)}
                placeholder={`Type your ${customDepartmentLabel.toLowerCase()}`}
                className="w-full min-h-[48px] px-4 py-3 text-base bg-white border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            {/* 3. Photo (Camera or Upload) */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="block text-sm font-semibold text-slate-900">
                  3. Verification Photo <span className="text-rose-600">*</span>
                </span>
                {photoDataUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setPhotoDataUrl(null);
                      setCameraError(null);
                    }}
                    className="text-xs font-semibold text-blue-700 hover:text-blue-900 min-h-[32px] px-2"
                  >
                    Clear Photo
                  </button>
                )}
              </div>

              {/* Hidden Native Device Camera Input */}
              <input
                ref={nativeCameraInputRef}
                type="file"
                accept="image/*"
                capture="user"
                onChange={handleFileChange}
                className="hidden"
                aria-label="Take a photo with device camera"
              />

              {photoDataUrl ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 flex flex-col sm:flex-row items-center gap-4">
                  <div className="w-36 h-36 rounded-xl overflow-hidden border border-slate-200 bg-white shrink-0">
                    <img
                      src={photoDataUrl}
                      alt="Captured participant preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-1 text-center sm:text-left space-y-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        Photo ready for submission
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Automatically compressed for fast check-in on mobile connections.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPhotoDataUrl(null);
                          void startCamera(cameraFacing);
                        }}
                        className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors flex items-center gap-1.5"
                      >
                        <Camera className="w-4 h-4" />
                        <span>Retake Picture</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : cameraOpen ? (
                <div className="rounded-2xl border border-slate-300 bg-slate-950 overflow-hidden">
                  <div className="relative aspect-[4/3] w-full bg-slate-900 flex items-center justify-center">
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      autoPlay
                      className={`w-full h-full object-cover ${
                        cameraFacing === 'user' ? '-scale-x-100' : ''
                      }`}
                    />
                  </div>
                  <div className="p-3 bg-slate-900 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCameraOpen(false);
                        stopCameraStream();
                      }}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold hover:bg-slate-700 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleToggleFacing}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold hover:bg-slate-700 transition-colors flex items-center gap-1.5"
                    >
                      <FlipHorizontal2 className="w-4 h-4" />
                      <span>Flip Camera</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCaptureSnapshot}
                      className="min-h-[44px] px-5 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors flex items-center gap-2"
                    >
                      <Camera className="w-4 h-4" />
                      <span>Capture Photo</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-5 space-y-3">
                  <button
                    type="button"
                    onClick={() => void startCamera(cameraFacing)}
                    disabled={processingPhoto}
                    className="w-full min-h-[54px] px-4 py-3 rounded-xl bg-white border border-slate-300 text-sm font-semibold text-slate-900 hover:bg-slate-100 transition-colors flex items-center justify-center gap-2"
                  >
                    <Camera className="w-5 h-5 text-blue-700" />
                    <span>Take Picture (Camera)</span>
                  </button>

                  <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
                    <span>
                      Take a live selfie using your device camera to verify attendance.
                    </span>
                    <button
                      type="button"
                      onClick={() => nativeCameraInputRef.current?.click()}
                      className="text-blue-700 hover:underline font-medium shrink-0"
                    >
                      Use native phone camera app
                    </button>
                  </div>
                </div>
              )}

              {processingPhoto && (
                <p className="mt-2 text-xs text-blue-700 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Optimizing photo...</span>
                </p>
              )}

              {cameraError && (
                <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {cameraError}
                </p>
              )}
            </div>

            {/* Required Late Excuse Field when checking in past cutoff */}
            {selectedEvent && liveStatus === 'Late' && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="late-excuse"
                    className="flex items-center gap-1.5 text-sm font-semibold text-amber-950"
                  >
                    <Clock className="w-4 h-4 text-amber-700" />
                    <span>
                      Excuse for Being Late <span className="text-rose-600">*</span>
                    </span>
                  </label>
                  <span className="text-xs font-mono-tabular text-amber-800">
                    {lateExcuse.length}/300
                  </span>
                </div>
                <p className="text-xs text-amber-900">
                  Check-in is past the {selectedEvent.lateCutoffTime} cutoff time. Please type your reason before submitting.
                </p>
                <textarea
                  id="late-excuse"
                  name="lateExcuse"
                  required
                  rows={2}
                  maxLength={300}
                  value={lateExcuse}
                  onChange={(e) => setLateExcuse(e.target.value)}
                  placeholder="e.g. Traffic delay, parent conference ran over, classroom handover..."
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-amber-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>
            )}

            {/* Consent Checkbox */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <label
                htmlFor="photo-consent"
                className="flex items-start gap-3 cursor-pointer select-none"
              >
                <span className="min-h-[44px] min-w-[44px] -m-2 flex items-center justify-center shrink-0">
                  <input
                    id="photo-consent"
                    type="checkbox"
                    checked={photoConsent}
                    onChange={(e) => setPhotoConsent(e.target.checked)}
                    className="w-5 h-5 rounded border-slate-300 text-blue-700 focus:ring-2 focus:ring-blue-600 cursor-pointer"
                  />
                </span>
                <span className="text-sm text-slate-700 leading-relaxed pt-0.5">
                  {customConsentText}
                </span>
              </label>
            </div>

            {formError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 flex items-start gap-2.5"
              >
                <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            {/* Large SUBMIT ATTENDANCE CTA Button */}
            <button
              type="submit"
              disabled={
                submitting ||
                !selectedEvent ||
                (requiresParticipantLogin && !participantVerifiedEmail)
              }
              className="w-full h-14 px-6 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed text-white text-base font-bold tracking-wide transition-all flex items-center justify-center gap-2.5 shadow-sm"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>RECORDING ATTENDANCE...</span>
                </>
              ) : (
                <>
                  <UserCheck className="w-5 h-5" />
                  <span>SUBMIT ATTENDANCE</span>
                </>
              )}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
