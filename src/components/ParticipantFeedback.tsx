import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Loader2,
  MapPin,
  MessageSquare,
  Send,
  Sparkles,
  Square,
  Star,
  UserCheck,
  Users,
} from 'lucide-react';
import { type User } from 'firebase/auth';
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
import { useEffect, useMemo, useState } from 'react';
import { db, handleFirestoreError, normalizeAdminEmail } from '../firebase';
import {
  type EventRecord,
  type FeedbackConfig,
  type FeedbackRatingEntry,
  type FeedbackStatementSelection,
  OperationType,
} from '../types';
import { formatLocalDateYmd, generateSafeId } from '../utils/dateTime';
import { mergeFeedbackConfig } from '../utils/feedbackAndRecognitionDefaults';

interface ParticipantFeedbackProps {
  requestedEventId: string | null;
  user?: User | null;
  onSelectEventId: (eventId: string | null) => void;
  onGoToCheckIn?: (eventId?: string | null) => void;
  onGoToAdmin?: () => void;
}

interface StoredCheckInHint {
  attendanceId?: string;
  fullName?: string;
  classDepartment?: string;
  participantEmail?: string;
}

interface StoredFeedbackReceipt {
  submissionId: string;
  eventId: string;
  eventTitle: string;
  averageRating: number;
  submittedAtIso: string;
  selectedCount: number;
}

const STAR_LABELS: Record<number, string> = {
  1: 'Needs improvement',
  2: 'Fair',
  3: 'Good',
  4: 'Very Good',
  5: 'Excellent',
};

function readCheckInHint(eventId: string): StoredCheckInHint | null {
  try {
    const raw = window.localStorage.getItem(`presenza_last_checkin_${eventId}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredCheckInHint;
  } catch {
    return null;
  }
}

function readFeedbackReceipt(eventId: string): StoredFeedbackReceipt | null {
  try {
    const raw = window.localStorage.getItem(
      `presenza_feedback_submitted_${eventId}`
    );
    if (!raw) return null;
    return JSON.parse(raw) as StoredFeedbackReceipt;
  } catch {
    return null;
  }
}

export default function ParticipantFeedback({
  requestedEventId,
  user = null,
  onSelectEventId,
  onGoToCheckIn,
  onGoToAdmin,
}: ParticipantFeedbackProps) {
  const [activeEvents, setActiveEvents] = useState<EventRecord[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventError, setEventError] = useState<string | null>(null);

  const [feedbackConfig, setFeedbackConfig] = useState<FeedbackConfig>(() =>
    mergeFeedbackConfig(null, 'default')
  );
  const [loadingConfig, setLoadingConfig] = useState(false);

  // Interactive Form State
  const [ratingsMap, setRatingsMap] = useState<Record<string, number>>({});
  const [selectedStatementIds, setSelectedStatementIds] = useState<Set<string>>(
    () => new Set()
  );
  const [writtenComment, setWrittenComment] = useState('');
  const [participantName, setParticipantName] = useState('');
  const [participantDepartment, setParticipantDepartment] = useState('');
  const [linkedAttendanceId, setLinkedAttendanceId] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submittedReceipt, setSubmittedReceipt] =
    useState<StoredFeedbackReceipt | null>(null);

  // Subscribe to open active events
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

  // Auto-resolve event from QR URL or default active session
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
        try {
          const snap = await getDoc(doc(db, 'events', requestedEventId));
          if (cancelled) return;
          if (!snap.exists()) {
            setSelectedEvent(null);
            setEventError(
              'This feedback QR session was not found. Select an active session below if available.'
            );
          } else {
            const data = snap.data() as Omit<EventRecord, 'id'>;
            if (data.status !== 'active') {
              setSelectedEvent(null);
              setEventError(
                'Feedback submissions for this session have been closed by the organizer.'
              );
            } else {
              setSelectedEvent({ id: snap.id, ...data });
            }
          }
        } catch {
          if (!cancelled) {
            setSelectedEvent(null);
            setEventError(
              'Unable to load this feedback session or submissions are currently closed.'
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

  // Load feedback form configuration (per-event override -> default -> built-in defaults) + check-in hint / duplicate receipt
  useEffect(() => {
    let active = true;

    async function loadConfigAndContext() {
      if (!selectedEvent) {
        setFeedbackConfig(mergeFeedbackConfig(null, 'default'));
        setSubmittedReceipt(null);
        return;
      }

      setLoadingConfig(true);
      setFormError(null);
      setRatingsMap({});
      setSelectedStatementIds(new Set());
      setWrittenComment('');

      // Check local device duplicate submission lock
      const priorReceipt = readFeedbackReceipt(selectedEvent.id);
      if (active) {
        setSubmittedReceipt(priorReceipt);
      }

      // Auto-associate participant identification from device check-in receipt if available
      const checkInHint = readCheckInHint(selectedEvent.id);
      if (active) {
        setParticipantName(
          checkInHint?.fullName || user?.displayName?.trim() || ''
        );
        setParticipantDepartment(checkInHint?.classDepartment || '');
        setLinkedAttendanceId(checkInHint?.attendanceId || '');
      }

      try {
        const eventCfgSnap = await getDoc(
          doc(db, 'feedbackConfigs', selectedEvent.id)
        );
        if (!active) return;
        if (eventCfgSnap.exists()) {
          setFeedbackConfig(
            mergeFeedbackConfig(
              eventCfgSnap.data() as Partial<FeedbackConfig>,
              selectedEvent.id
            )
          );
          setLoadingConfig(false);
          return;
        }

        const defaultCfgSnap = await getDoc(
          doc(db, 'feedbackConfigs', 'default')
        );
        if (!active) return;
        if (defaultCfgSnap.exists()) {
          setFeedbackConfig(
            mergeFeedbackConfig(
              defaultCfgSnap.data() as Partial<FeedbackConfig>,
              selectedEvent.id
            )
          );
        } else {
          setFeedbackConfig(mergeFeedbackConfig(null, selectedEvent.id));
        }
      } catch {
        if (active) {
          setFeedbackConfig(mergeFeedbackConfig(null, selectedEvent.id));
        }
      } finally {
        if (active) {
          setLoadingConfig(false);
        }
      }
    }

    void loadConfigAndContext();
    return () => {
      active = false;
    };
  }, [selectedEvent?.id, user?.displayName]);

  const activeCriteria = useMemo(
    () => feedbackConfig.ratingCriteria.filter((c) => c.active),
    [feedbackConfig.ratingCriteria]
  );

  const activeStatementsByCategory = useMemo(() => {
    const activeList = feedbackConfig.statements.filter((s) => s.active);
    return feedbackConfig.categories
      .map((cat) => ({
        category: cat,
        statements: activeList.filter((s) => s.categoryId === cat.id),
      }))
      .filter((group) => group.statements.length > 0);
  }, [feedbackConfig.categories, feedbackConfig.statements]);

  const ratedScores = useMemo(() => {
    const entries = activeCriteria
      .map((c) => ratingsMap[c.id])
      .filter((score): score is number => typeof score === 'number' && score >= 1);
    if (entries.length === 0) return { count: 0, average: 0 };
    const sum = entries.reduce((acc, s) => acc + s, 0);
    return {
      count: entries.length,
      average: Math.round((sum / entries.length) * 100) / 100,
    };
  }, [activeCriteria, ratingsMap]);

  const toggleStatement = (id: string) => {
    setSelectedStatementIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEvent || submitting || submittedReceipt) return;
    setFormError(null);

    // 1. Validate mandatory rating criteria
    const missingCriteria = activeCriteria.filter(
      (c) => c.required && !(ratingsMap[c.id] >= 1 && ratingsMap[c.id] <= 5)
    );
    if (missingCriteria.length > 0) {
      setFormError(
        `Please rate "${missingCriteria[0].label}" before submitting your evaluation.`
      );
      return;
    }

    // 2. Validate mandatory checklist statements if any
    const missingRequiredStatement = feedbackConfig.statements.find(
      (s) => s.active && s.required && !selectedStatementIds.has(s.id)
    );
    if (missingRequiredStatement) {
      setFormError(
        `Please confirm the required feedback statement: "${missingRequiredStatement.text}"`
      );
      return;
    }

    // 3. Validate written comment if mandatory
    const cleanComment = writtenComment.trim().slice(0, 1500);
    if (feedbackConfig.requireWrittenComment && cleanComment.length < 3) {
      setFormError(
        'Please share a brief comment or suggestion in the written feedback box.'
      );
      return;
    }

    // Build payload
    const ratingEntries: FeedbackRatingEntry[] = activeCriteria
      .filter((c) => ratingsMap[c.id] >= 1 && ratingsMap[c.id] <= 5)
      .map((c) => ({
        criterionId: c.id.slice(0, 80),
        label: c.label.slice(0, 120),
        score: ratingsMap[c.id],
      }));

    if (ratingEntries.length === 0 && selectedStatementIds.size === 0 && !cleanComment) {
      setFormError(
        'Please provide at least one star rating, checklist selection, or written comment before submitting.'
      );
      return;
    }

    const avg =
      ratingEntries.length > 0
        ? Math.round(
            (ratingEntries.reduce((acc, r) => acc + r.score, 0) /
              ratingEntries.length) *
              100
          ) / 100
        : 0;

    const categoryMap = new Map(
      feedbackConfig.categories.map((c) => [c.id, c])
    );
    const statementSelections: FeedbackStatementSelection[] =
      feedbackConfig.statements
        .filter((s) => s.active && selectedStatementIds.has(s.id))
        .map((s) => {
          const cat = categoryMap.get(s.categoryId);
          return {
            statementId: s.id.slice(0, 80),
            categoryId: s.categoryId.slice(0, 80),
            categoryName: (cat?.name || 'Feedback').slice(0, 80),
            sentiment: cat?.sentiment === 'improvement' ? 'improvement' : 'positive',
            text: s.text.slice(0, 200),
          };
        });

    const submissionId = generateSafeId('fbk');
    const clientToken = generateSafeId('tok');
    const eventDateVal =
      /^\d{4}-\d{2}-\d{2}$/.test(selectedEvent.eventDate)
        ? selectedEvent.eventDate
        : formatLocalDateYmd(new Date());

    const payload: Record<string, unknown> = {
      eventId: selectedEvent.id,
      eventTitle: selectedEvent.title,
      eventDate: eventDateVal,
      eventVenue: (selectedEvent.venue || '').slice(0, 120),
      facilitatorName: (
        selectedEvent.facilitators?.trim() || 'Session Facilitator'
      ).slice(0, 200),
      sessionTopic: (
        selectedEvent.topic?.trim() ||
        selectedEvent.theme?.trim() ||
        selectedEvent.category ||
        ''
      ).slice(0, 200),
      ratings: ratingEntries,
      averageRating: avg,
      selectedStatements: statementSelections,
      writtenComment: cleanComment,
      clientSubmissionToken: clientToken,
      serverTimestamp: serverTimestamp(),
    };

    const cleanName = participantName.trim().slice(0, 100);
    const cleanDept = participantDepartment.trim().slice(0, 100);
    if (cleanName) payload.participantName = cleanName;
    if (cleanDept) payload.participantDepartment = cleanDept;

    const checkInHint = readCheckInHint(selectedEvent.id);
    const verifiedEmail =
      user?.email && user.emailVerified
        ? normalizeAdminEmail(user.email)
        : checkInHint?.participantEmail || '';
    if (verifiedEmail) {
      payload.participantEmail = verifiedEmail.slice(0, 128);
    }
    if (linkedAttendanceId && /^[a-zA-Z0-9_-]{1,128}$/.test(linkedAttendanceId)) {
      payload.attendanceId = linkedAttendanceId;
    }

    setSubmitting(true);
    try {
      await setDoc(doc(db, 'feedbackSubmissions', submissionId), payload);

      const receipt: StoredFeedbackReceipt = {
        submissionId,
        eventId: selectedEvent.id,
        eventTitle: selectedEvent.title,
        averageRating: avg,
        submittedAtIso: new Date().toISOString(),
        selectedCount: statementSelections.length,
      };
      try {
        window.localStorage.setItem(
          `presenza_feedback_submitted_${selectedEvent.id}`,
          JSON.stringify(receipt)
        );
      } catch {
        // Ignore storage quota errors cleanly
      }
      setSubmittedReceipt(receipt);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.toLowerCase().includes('permission')) {
        setFormError(
          'Unable to submit feedback. This session may have been closed by the organizer.'
        );
      } else {
        setFormError(
          'Network error while saving feedback. Please try again.'
        );
      }
      try {
        handleFirestoreError(
          error,
          OperationType.CREATE,
          `feedbackSubmissions/${submissionId}`
        );
      } catch {
        // Logged for diagnostics; friendly error shown above
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Thank-You / Duplicate Prevention Screen
  if (selectedEvent && submittedReceipt) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="p-6 sm:p-8 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div>
              <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-700">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Feedback Recorded</span>
              </span>
              <h1 className="mt-1 text-2xl font-bold text-slate-900">
                Thank You for Your Evaluation
              </h1>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
                Your evaluation for{' '}
                <span className="font-semibold text-slate-900">
                  {submittedReceipt.eventTitle}
                </span>{' '}
                has been saved safely. Duplicate submissions from this device for this event are prevented automatically.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto pt-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-medium text-slate-500">
                  Average Rating
                </div>
                <div className="mt-1 text-xl font-bold font-mono-tabular text-amber-600 flex items-center justify-center gap-1">
                  <Star className="w-4 h-4 fill-amber-400 text-amber-500" />
                  <span>
                    {submittedReceipt.averageRating > 0
                      ? submittedReceipt.averageRating.toFixed(1)
                      : '—'}
                  </span>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-medium text-slate-500">
                  Checklist Items
                </div>
                <div className="mt-1 text-xl font-bold font-mono-tabular text-slate-900">
                  {submittedReceipt.selectedCount}
                </div>
              </div>
            </div>
          </div>

          <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
            <span className="text-xs font-mono-tabular text-slate-500">
              Recorded: {submittedReceipt.submittedAtIso.slice(0, 16).replace('T', ' ')} UTC
            </span>
            {onGoToCheckIn && (
              <button
                type="button"
                onClick={() => onGoToCheckIn(selectedEvent.id)}
                className="min-h-[40px] px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 transition-colors whitespace-nowrap"
              >
                Back to Event Check-In
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 space-y-6">
      {eventError && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm text-amber-900"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <span>{eventError}</span>
          </div>
          {activeEvents.length > 0 && (
            <button
              type="button"
              onClick={() => onSelectEventId(activeEvents[0].id)}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-amber-900 text-white text-xs font-semibold hover:bg-amber-800 whitespace-nowrap shrink-0"
            >
              Switch to Active Session
            </button>
          )}
        </div>
      )}

      {!loadingEvents && activeEvents.length === 0 && !selectedEvent && (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 text-center space-y-3">
          <h1 className="text-xl font-bold text-slate-900">
            No Open Session for Feedback
          </h1>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            {onGoToAdmin
              ? 'Open an active workshop or seminar session in the Admin Console to collect participant feedback and evaluations.'
              : 'Please scan an active event feedback QR code provided by your session facilitator.'}
          </p>
          {onGoToAdmin && (
            <button
              type="button"
              onClick={onGoToAdmin}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors"
            >
              Open Admin Console
            </button>
          )}
        </div>
      )}

      {selectedEvent && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Section 1: Event Information Card */}
          <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-2xl p-6 space-y-5 lg:sticky lg:top-24">
            <div>
              <div className="flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wider text-blue-700">
                <span>Feedback &amp; Evaluation</span>
                <span>No Login Required</span>
              </div>
              <h1 className="mt-2 text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                {selectedEvent.title}
              </h1>
              {feedbackConfig.introNote && (
                <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                  {feedbackConfig.introNote}
                </p>
              )}
            </div>

            {!requestedEventId && activeEvents.length > 1 && (
              <div className="pt-4 border-t border-slate-100">
                <label
                  htmlFor="feedback-event-select"
                  className="block text-xs font-semibold text-slate-600 mb-1.5"
                >
                  Select Active Event ({activeEvents.length} open)
                </label>
                <select
                  id="feedback-event-select"
                  value={selectedEvent.id}
                  onChange={(e) => onSelectEventId(e.target.value || null)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {activeEvents.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title} ({ev.eventDate})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <dl className="pt-4 border-t border-slate-100 divide-y divide-slate-100 text-sm">
              <div className="py-2.5 flex items-start justify-between gap-3">
                <dt className="text-slate-500 inline-flex items-center gap-1.5 shrink-0">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  <span>Date</span>
                </dt>
                <dd className="font-mono-tabular font-semibold text-slate-900 text-right">
                  {selectedEvent.eventDate}
                </dd>
              </div>
              <div className="py-2.5 flex items-start justify-between gap-3">
                <dt className="text-slate-500 inline-flex items-center gap-1.5 shrink-0">
                  <MapPin className="w-3.5 h-3.5 text-slate-400" />
                  <span>Location</span>
                </dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {selectedEvent.venue}
                </dd>
              </div>
              <div className="py-2.5 flex items-start justify-between gap-3">
                <dt className="text-slate-500 inline-flex items-center gap-1.5 shrink-0">
                  <Users className="w-3.5 h-3.5 text-slate-400" />
                  <span>Facilitator</span>
                </dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {selectedEvent.facilitators?.trim() || 'Session Facilitator'}
                </dd>
              </div>
              <div className="py-2.5 flex items-start justify-between gap-3">
                <dt className="text-slate-500 shrink-0">Session / Topic</dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {selectedEvent.topic?.trim() ||
                    selectedEvent.theme?.trim() ||
                    selectedEvent.category}
                </dd>
              </div>
            </dl>

            {ratedScores.count > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 flex items-center justify-between text-xs">
                <span className="font-medium text-amber-950">
                  Your Avg Rating ({ratedScores.count}/{activeCriteria.length})
                </span>
                <span className="font-mono-tabular font-bold text-amber-700 inline-flex items-center gap-1">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-500" />
                  {ratedScores.average.toFixed(1)} / 5.0
                </span>
              </div>
            )}
          </aside>

          {/* Right Form Sections */}
          <form
            onSubmit={handleSubmit}
            noValidate
            className="lg:col-span-8 bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-8"
          >
            {loadingConfig && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
                <span>Loading customized evaluation form...</span>
              </div>
            )}

            {/* Section 2: Interactive 1–5 Star Satisfaction Rating */}
            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  1. Satisfaction Rating (1–5 Stars)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Tap a star from 1 (Needs improvement) to 5 (Excellent) for each area.
                </p>
              </div>

              <div className="space-y-3">
                {activeCriteria.map((criterion) => {
                  const score = ratingsMap[criterion.id] ?? 0;
                  return (
                    <div
                      key={criterion.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900">
                          {criterion.label}{' '}
                          {criterion.required && (
                            <span className="text-rose-600">*</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {score > 0
                            ? `${score} / 5 · ${STAR_LABELS[score]}`
                            : criterion.required
                            ? 'Required rating'
                            : 'Optional rating'}
                        </div>
                      </div>

                      <div
                        className="flex items-center gap-1 shrink-0"
                        role="radiogroup"
                        aria-label={criterion.label}
                      >
                        {[1, 2, 3, 4, 5].map((starValue) => {
                          const filled = starValue <= score;
                          return (
                            <button
                              key={starValue}
                              type="button"
                              onClick={() =>
                                setRatingsMap((prev) => ({
                                  ...prev,
                                  [criterion.id]: starValue,
                                }))
                              }
                              aria-label={`${criterion.label}: ${starValue} out of 5 stars`}
                              aria-checked={score === starValue}
                              role="radio"
                              className="min-w-[40px] min-h-[40px] rounded-lg flex items-center justify-center hover:bg-amber-50 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
                            >
                              <Star
                                className={`w-6 h-6 transition-transform ${
                                  filled
                                    ? 'fill-amber-400 text-amber-500 scale-105'
                                    : 'text-slate-300 hover:text-amber-300'
                                }`}
                              />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Section 3: Quick Feedback / Checklist */}
            {activeStatementsByCategory.length > 0 && (
              <section className="pt-6 border-t border-slate-200 space-y-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    2. Quick Feedback Checklist
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Tick all statements that match your experience in this session.
                  </p>
                </div>

                <div className="space-y-5">
                  {activeStatementsByCategory.map(({ category, statements }) => (
                    <div key={category.id} className="space-y-2.5">
                      <h3
                        className={`text-xs font-bold uppercase tracking-wider ${
                          category.sentiment === 'positive'
                            ? 'text-emerald-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {category.name}
                      </h3>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {statements.map((stmt) => {
                          const checked = selectedStatementIds.has(stmt.id);
                          const isPositive = category.sentiment === 'positive';
                          return (
                            <button
                              key={stmt.id}
                              type="button"
                              onClick={() => toggleStatement(stmt.id)}
                              aria-pressed={checked}
                              className={`text-left p-3.5 rounded-xl border transition-colors flex items-start gap-2.5 ${
                                checked
                                  ? isPositive
                                    ? 'border-emerald-500 bg-emerald-50/70 text-emerald-950'
                                    : 'border-amber-500 bg-amber-50/70 text-amber-950'
                                  : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-800'
                              }`}
                            >
                              {checked ? (
                                <CheckSquare
                                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                                    isPositive
                                      ? 'text-emerald-700'
                                      : 'text-amber-700'
                                  }`}
                                />
                              ) : (
                                <Square className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
                              )}
                              <span className="text-xs sm:text-sm font-medium leading-snug">
                                {stmt.text}{' '}
                                {stmt.required && (
                                  <span className="text-rose-600 font-bold">*</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Section 4: Written Comments */}
            <section className="pt-6 border-t border-slate-200 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="feedback-written-comment"
                  className="text-lg font-bold text-slate-900 inline-flex items-center gap-2"
                >
                  <MessageSquare className="w-4 h-4 text-blue-700" />
                  <span>
                    3. Written Comments{' '}
                    {feedbackConfig.requireWrittenComment && (
                      <span className="text-rose-600">*</span>
                    )}
                  </span>
                </label>
                <span className="text-xs font-mono-tabular text-slate-400">
                  {writtenComment.length}/1500
                </span>
              </div>
              <textarea
                id="feedback-written-comment"
                rows={4}
                maxLength={1500}
                value={writtenComment}
                onChange={(e) => setWrittenComment(e.target.value)}
                placeholder="Please share your comments, suggestions, or recommendations."
                className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </section>

            {/* Optional Participant Identification (auto-filled when checked in) */}
            <section className="pt-5 border-t border-slate-200 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-600 inline-flex items-center gap-1.5">
                  <UserCheck className="w-3.5 h-3.5 text-blue-700" />
                  <span>Participant Identification (Optional)</span>
                </span>
                {linkedAttendanceId && (
                  <span className="text-[11px] font-semibold text-emerald-700">
                    Linked to check-in record
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  maxLength={100}
                  value={participantName}
                  onChange={(e) => setParticipantName(e.target.value)}
                  placeholder="Your name (optional, leave blank to stay anonymous)"
                  aria-label="Participant name (optional)"
                  className="min-h-[42px] px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <input
                  type="text"
                  maxLength={100}
                  value={participantDepartment}
                  onChange={(e) => setParticipantDepartment(e.target.value)}
                  placeholder="Class / Department (optional)"
                  aria-label="Class or department (optional)"
                  className="min-h-[42px] px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </section>

            {formError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs sm:text-sm text-rose-800 font-medium"
              >
                {formError}
              </div>
            )}

            <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                {ratedScores.count > 0
                  ? `${ratedScores.count} rating(s) and ${selectedStatementIds.size} checklist item(s) ready.`
                  : 'Complete the star ratings and submit your evaluation.'}
              </span>
              <button
                type="submit"
                disabled={submitting}
                className="w-full sm:w-auto min-h-[48px] px-6 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                <span>{submitting ? 'Submitting...' : 'Submit Feedback'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
