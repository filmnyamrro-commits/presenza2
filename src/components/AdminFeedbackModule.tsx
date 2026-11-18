import {
  BarChart3,
  Check,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Loader2,
  MessageSquare,
  Plus,
  QrCode,
  RotateCcw,
  Save,
  Settings2,
  Star,
  ThumbsUp,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { type User } from 'firebase/auth';
import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { db, handleFirestoreError } from '../firebase';
import {
  type EventRecord,
  type FeedbackConfig,
  type FeedbackSubmissionRecord,
  OperationType,
} from '../types';
import { exportFeedbackCsv } from '../utils/csvExport';
import { generateSafeId } from '../utils/dateTime';
import {
  buildDefaultFeedbackConfig,
  mergeFeedbackConfig,
} from '../utils/feedbackAndRecognitionDefaults';

interface AdminFeedbackModuleProps {
  user: User;
  events: EventRecord[];
  feedbackConfigsById: Map<string, FeedbackConfig>;
  feedbackSubmissions: FeedbackSubmissionRecord[];
  onOpenFeedbackForm: (eventId: string) => void;
}

export default function AdminFeedbackModule({
  user,
  events,
  feedbackConfigsById,
  feedbackSubmissions,
  onOpenFeedbackForm,
}: AdminFeedbackModuleProps) {
  const [subTab, setSubTab] = useState<'analytics' | 'customize'>('analytics');

  // Analytics Filters
  const [filterEventId, setFilterEventId] = useState<string>('all');
  const [filterDate, setFilterDate] = useState<string>('all');
  const [filterFacilitator, setFilterFacilitator] = useState<string>('all');
  const [filterTopic, setFilterTopic] = useState<string>('all');

  // Feedback QR Share state
  const [qrTargetEventId, setQrTargetEventId] = useState<string>(
    () => events.find((e) => e.status === 'active')?.id || events[0]?.id || ''
  );
  const [feedbackQrDataUrl, setFeedbackQrDataUrl] = useState<string>('');
  const [copiedQrUrl, setCopiedQrUrl] = useState(false);

  // Deleting a single feedback response
  const [deletingSubmissionId, setDeletingSubmissionId] = useState<string | null>(
    null
  );

  // Form Customizer State
  const [configTargetId, setConfigTargetId] = useState<string>('default');
  const [draftConfig, setDraftConfig] = useState<FeedbackConfig>(() =>
    mergeFeedbackConfig(feedbackConfigsById.get('default'), 'default')
  );
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSaved, setConfigSaved] = useState(false);

  // New inputs in Form Customizer
  const [newCriterionLabel, setNewCriterionLabel] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategorySentiment, setNewCategorySentiment] = useState<
    'positive' | 'improvement'
  >('positive');
  const [newStatementCategory, setNewStatementCategory] =
    useState<string>('cat_positive');
  const [newStatementText, setNewStatementText] = useState('');

  // Keep QR target valid when events update
  useEffect(() => {
    if (events.length === 0) {
      setQrTargetEventId('');
      return;
    }
    if (!events.some((e) => e.id === qrTargetEventId)) {
      setQrTargetEventId(
        events.find((e) => e.status === 'active')?.id || events[0].id
      );
    }
  }, [events, qrTargetEventId]);

  // Sync draftConfig whenever target scope or remote configs change cleanly
  useEffect(() => {
    const specific = feedbackConfigsById.get(configTargetId);
    const fallbackDefault = feedbackConfigsById.get('default');
    const merged = mergeFeedbackConfig(
      specific ?? fallbackDefault ?? null,
      configTargetId
    );
    setDraftConfig(merged);
    if (
      merged.categories.length > 0 &&
      !merged.categories.some((c) => c.id === newStatementCategory)
    ) {
      setNewStatementCategory(merged.categories[0].id);
    }
  }, [configTargetId, feedbackConfigsById]);

  const feedbackQrUrl = qrTargetEventId
    ? `${window.location.origin}/?view=feedback&event=${encodeURIComponent(
        qrTargetEventId
      )}`
    : '';

  useEffect(() => {
    if (!feedbackQrUrl) {
      setFeedbackQrDataUrl('');
      return;
    }
    let active = true;
    QRCode.toDataURL(feedbackQrUrl, {
      width: 480,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setFeedbackQrDataUrl(url);
      })
      .catch(() => {
        if (active) setFeedbackQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [feedbackQrUrl]);

  // Filter options derived from submissions + events
  const filterOptions = useMemo(() => {
    const dates = Array.from(
      new Set(feedbackSubmissions.map((s) => s.eventDate).filter(Boolean))
    ).sort((a, b) => b.localeCompare(a));

    const facilitators = Array.from(
      new Set(
        feedbackSubmissions.map((s) => s.facilitatorName.trim()).filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    const topics = Array.from(
      new Set(
        feedbackSubmissions.map((s) => s.sessionTopic.trim()).filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    return { dates, facilitators, topics };
  }, [feedbackSubmissions]);

  const filteredSubmissions = useMemo(() => {
    return feedbackSubmissions.filter((sub) => {
      if (filterEventId !== 'all' && sub.eventId !== filterEventId) {
        return false;
      }
      if (filterDate !== 'all' && sub.eventDate !== filterDate) {
        return false;
      }
      if (
        filterFacilitator !== 'all' &&
        sub.facilitatorName.trim() !== filterFacilitator
      ) {
        return false;
      }
      if (filterTopic !== 'all' && sub.sessionTopic.trim() !== filterTopic) {
        return false;
      }
      return true;
    });
  }, [
    feedbackSubmissions,
    filterEventId,
    filterDate,
    filterFacilitator,
    filterTopic,
  ]);

  // Computed Analytics
  const analytics = useMemo(() => {
    const total = filteredSubmissions.length;
    const ratedSubs = filteredSubmissions.filter((s) => s.averageRating > 0);
    const overallAverage =
      ratedSubs.length > 0
        ? ratedSubs.reduce((acc, s) => acc + s.averageRating, 0) /
          ratedSubs.length
        : 0;

    // 1..5 Star Distribution across all individual criterion scores
    const starCounts: Record<1 | 2 | 3 | 4 | 5, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    let totalStarVotes = 0;

    // Average per Criterion
    const criterionAgg = new Map<
      string,
      { label: string; sum: number; count: number }
    >();

    // Frequency of positive & improvement statements
    const positiveCounts = new Map<string, number>();
    const improvementCounts = new Map<string, number>();
    let totalPositiveTicks = 0;
    let totalImprovementTicks = 0;

    // Breakdown by Event + Facilitator + Topic
    const groupMap = new Map<
      string,
      {
        eventId: string;
        eventTitle: string;
        eventDate: string;
        facilitatorName: string;
        sessionTopic: string;
        responses: number;
        ratingSum: number;
        ratedCount: number;
        commentsCount: number;
      }
    >();

    for (const sub of filteredSubmissions) {
      for (const r of sub.ratings) {
        const rounded = Math.min(5, Math.max(1, Math.round(r.score))) as
          | 1
          | 2
          | 3
          | 4
          | 5;
        starCounts[rounded] += 1;
        totalStarVotes += 1;

        const key = r.label || r.criterionId;
        const curr = criterionAgg.get(key) || {
          label: r.label,
          sum: 0,
          count: 0,
        };
        curr.sum += r.score;
        curr.count += 1;
        criterionAgg.set(key, curr);
      }

      for (const st of sub.selectedStatements) {
        if (st.sentiment === 'improvement') {
          improvementCounts.set(st.text, (improvementCounts.get(st.text) ?? 0) + 1);
          totalImprovementTicks += 1;
        } else {
          positiveCounts.set(st.text, (positiveCounts.get(st.text) ?? 0) + 1);
          totalPositiveTicks += 1;
        }
      }

      const gKey = `${sub.eventId}::${sub.facilitatorName}::${sub.sessionTopic}`;
      const g = groupMap.get(gKey) || {
        eventId: sub.eventId,
        eventTitle: sub.eventTitle,
        eventDate: sub.eventDate,
        facilitatorName: sub.facilitatorName || 'Session Facilitator',
        sessionTopic: sub.sessionTopic || 'General',
        responses: 0,
        ratingSum: 0,
        ratedCount: 0,
        commentsCount: 0,
      };
      g.responses += 1;
      if (sub.averageRating > 0) {
        g.ratingSum += sub.averageRating;
        g.ratedCount += 1;
      }
      if (sub.writtenComment.trim().length > 0) {
        g.commentsCount += 1;
      }
      groupMap.set(gKey, g);
    }

    const criterionAverages = Array.from(criterionAgg.values())
      .map((item) => ({
        label: item.label,
        average: item.count > 0 ? item.sum / item.count : 0,
        count: item.count,
      }))
      .sort((a, b) => b.average - a.average);

    const topPositive = Array.from(positiveCounts.entries())
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count);

    const topImprovements = Array.from(improvementCounts.entries())
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count);

    const groupedBreakdown = Array.from(groupMap.values()).sort((a, b) =>
      b.eventDate.localeCompare(a.eventDate)
    );

    const commentsList = filteredSubmissions.filter(
      (s) => s.writtenComment.trim().length > 0
    );

    const eventsCoveredCount = new Set(
      filteredSubmissions.map((s) => s.eventId)
    ).size;

    return {
      total,
      overallAverage,
      starCounts,
      totalStarVotes,
      criterionAverages,
      topPositive,
      topImprovements,
      totalPositiveTicks,
      totalImprovementTicks,
      groupedBreakdown,
      commentsList,
      eventsCoveredCount,
    };
  }, [filteredSubmissions]);

  const handleCopyFeedbackQrUrl = async () => {
    if (!feedbackQrUrl) return;
    try {
      await navigator.clipboard.writeText(feedbackQrUrl);
      setCopiedQrUrl(true);
      window.setTimeout(() => setCopiedQrUrl(false), 2000);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleDownloadFeedbackQrPng = () => {
    if (!feedbackQrDataUrl) return;
    const ev = events.find((e) => e.id === qrTargetEventId);
    const slug = (ev?.title || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const link = document.createElement('a');
    link.href = feedbackQrDataUrl;
    link.download = `presenza-feedback-qr-${slug}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDeleteSubmission = async (id: string) => {
    setDeletingSubmissionId(id);
    try {
      await deleteDoc(doc(db, 'feedbackSubmissions', id));
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `feedbackSubmissions/${id}`
      );
    } finally {
      setDeletingSubmissionId(null);
    }
  };

  // Customizer Mutations
  const handleAddCriterion = () => {
    const label = newCriterionLabel.trim().slice(0, 120);
    if (label.length < 2) return;
    if (draftConfig.ratingCriteria.length >= 12) {
      setConfigError('Maximum of 12 rating criteria reached.');
      return;
    }
    setDraftConfig((prev) => ({
      ...prev,
      ratingCriteria: [
        ...prev.ratingCriteria,
        {
          id: generateSafeId('crit'),
          label,
          active: true,
          required: true,
        },
      ],
    }));
    setNewCriterionLabel('');
    setConfigError(null);
  };

  const handleAddCategory = () => {
    const name = newCategoryName.trim().slice(0, 80);
    if (name.length < 2) return;
    if (draftConfig.categories.length >= 12) {
      setConfigError('Maximum of 12 feedback categories reached.');
      return;
    }
    const id = generateSafeId('cat');
    setDraftConfig((prev) => ({
      ...prev,
      categories: [
        ...prev.categories,
        { id, name, sentiment: newCategorySentiment },
      ],
    }));
    setNewStatementCategory(id);
    setNewCategoryName('');
    setConfigError(null);
  };

  const handleDeleteCategory = (catId: string) => {
    if (draftConfig.categories.length <= 1) {
      setConfigError('At least 1 feedback category must remain.');
      return;
    }
    const remaining = draftConfig.categories.filter((c) => c.id !== catId);
    setDraftConfig((prev) => ({
      ...prev,
      categories: remaining,
      statements: prev.statements.filter((s) => s.categoryId !== catId),
    }));
    if (newStatementCategory === catId && remaining[0]) {
      setNewStatementCategory(remaining[0].id);
    }
  };

  const handleAddStatement = () => {
    const text = newStatementText.trim().slice(0, 200);
    if (text.length < 2) return;
    if (draftConfig.statements.length >= 40) {
      setConfigError('Maximum of 40 checklist statements reached.');
      return;
    }
    const targetCat =
      draftConfig.categories.find((c) => c.id === newStatementCategory)?.id ||
      draftConfig.categories[0]?.id ||
      'cat_positive';

    setDraftConfig((prev) => ({
      ...prev,
      statements: [
        ...prev.statements,
        {
          id: generateSafeId('stmt'),
          categoryId: targetCat,
          text,
          active: true,
          required: false,
        },
      ],
    }));
    setNewStatementText('');
    setConfigError(null);
  };

  const handleSaveFeedbackConfig = async () => {
    setConfigError(null);
    setConfigSaved(false);

    if (draftConfig.ratingCriteria.length === 0) {
      setConfigError('Please keep at least 1 star rating criterion.');
      return;
    }
    if (draftConfig.categories.length === 0) {
      setConfigError('Please keep at least 1 feedback category.');
      return;
    }

    setSavingConfig(true);
    try {
      const payload = {
        eventId: configTargetId,
        introNote: draftConfig.introNote.trim().slice(0, 400),
        requireWrittenComment: draftConfig.requireWrittenComment,
        ratingCriteria: draftConfig.ratingCriteria.slice(0, 12),
        categories: draftConfig.categories.slice(0, 12),
        statements: draftConfig.statements.slice(0, 40),
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      };
      await setDoc(doc(db, 'feedbackConfigs', configTargetId), payload);
      setConfigSaved(true);
      window.setTimeout(() => setConfigSaved(false), 2500);
    } catch (error) {
      setConfigError(
        'Failed to save feedback form settings. Please verify all inputs.'
      );
      handleFirestoreError(
        error,
        OperationType.WRITE,
        `feedbackConfigs/${configTargetId}`
      );
    } finally {
      setSavingConfig(false);
    }
  };

  const hasCustomOverrideForTarget =
    configTargetId !== 'default' && feedbackConfigsById.has(configTargetId);

  return (
    <div className="space-y-6">
      {/* Sub-module Header & Mode Switch */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900">
            Participant Feedback &amp; Evaluation
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Track satisfaction scores, analyze recurring feedback themes, share event Feedback QR codes, and customize questions per event.
          </p>
        </div>

        <div
          className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1 self-start sm:self-auto"
          role="tablist"
          aria-label="Feedback management views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'analytics'}
            onClick={() => setSubTab('analytics')}
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'analytics'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5 text-blue-700" />
            <span>Feedback Dashboard ({feedbackSubmissions.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'customize'}
            onClick={() => setSubTab('customize')}
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'customize'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5 text-blue-700" />
            <span>Customize Form &amp; Checklist</span>
          </button>
        </div>
      </div>

      {subTab === 'analytics' ? (
        <div className="space-y-6">
          {/* Quick Feedback QR Share Strip */}
          {events.length > 0 && (
            <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-20 h-20 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden shrink-0">
                    {feedbackQrDataUrl ? (
                      <img
                        src={feedbackQrDataUrl}
                        alt="Event feedback QR code"
                        className="w-full h-full object-contain p-1 bg-white"
                      />
                    ) : (
                      <QrCode className="w-7 h-7 text-slate-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold uppercase tracking-wider text-blue-700">
                      Direct Feedback QR Link
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Scanning opens the event&apos;s feedback &amp; evaluation form automatically without logging in.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        value={qrTargetEventId}
                        onChange={(e) => setQrTargetEventId(e.target.value)}
                        aria-label="Select event for feedback QR code"
                        className="min-h-[36px] px-2.5 py-1 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 max-w-xs"
                      >
                        {events.map((ev) => (
                          <option key={ev.id} value={ev.id}>
                            {ev.title} ({ev.eventDate}
                            {ev.status === 'closed' ? ' · Closed' : ''})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleCopyFeedbackQrUrl()}
                        disabled={!feedbackQrUrl}
                        className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5"
                      >
                        {copiedQrUrl ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedQrUrl ? 'Copied Link' : 'Copy Link'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadFeedbackQrPng}
                        disabled={!feedbackQrDataUrl}
                        className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Save QR PNG</span>
                      </button>
                      {qrTargetEventId && (
                        <button
                          type="button"
                          onClick={() => onOpenFeedbackForm(qrTargetEventId)}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>Open Form</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Filters & Export Bar */}
          <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700">
                <Filter className="w-3.5 h-3.5 text-blue-700" />
                <span>Filter Feedback Results</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {(filterEventId !== 'all' ||
                  filterDate !== 'all' ||
                  filterFacilitator !== 'all' ||
                  filterTopic !== 'all') && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilterEventId('all');
                      setFilterDate('all');
                      setFilterFacilitator('all');
                      setFilterTopic('all');
                    }}
                    className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset Filters</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={filteredSubmissions.length === 0}
                  onClick={() =>
                    exportFeedbackCsv(
                      filteredSubmissions,
                      filterEventId !== 'all'
                        ? events.find((e) => e.id === filterEventId)?.title ||
                            'event-feedback'
                        : 'presenza-feedback-report'
                    )
                  }
                  className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export to Excel (CSV)</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <select
                value={filterEventId}
                onChange={(e) => setFilterEventId(e.target.value)}
                aria-label="Filter feedback by event"
                className="min-h-[40px] px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="all">All Events</option>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title}
                  </option>
                ))}
              </select>

              <select
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                aria-label="Filter feedback by date"
                className="min-h-[40px] px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="all">All Dates</option>
                {filterOptions.dates.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>

              <select
                value={filterFacilitator}
                onChange={(e) => setFilterFacilitator(e.target.value)}
                aria-label="Filter feedback by facilitator"
                className="min-h-[40px] px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="all">All Facilitators / Speakers</option>
                {filterOptions.facilitators.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>

              <select
                value={filterTopic}
                onChange={(e) => setFilterTopic(e.target.value)}
                aria-label="Filter feedback by topic"
                className="min-h-[40px] px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="all">All Sessions / Topics</option>
                {filterOptions.topics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* KPI Summary Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">
                Feedback Submissions
              </div>
              <div className="mt-2 text-2xl sm:text-3xl font-bold font-mono-tabular text-slate-900">
                {analytics.total}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Across {analytics.eventsCoveredCount}{' '}
                {analytics.eventsCoveredCount === 1 ? 'event' : 'events'}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">
                Overall Satisfaction
              </div>
              <div className="mt-2 text-2xl sm:text-3xl font-bold font-mono-tabular text-amber-600 flex items-center gap-1.5">
                <span>
                  {analytics.overallAverage > 0
                    ? analytics.overallAverage.toFixed(2)
                    : '—'}
                </span>
                <Star className="w-5 h-5 fill-amber-400 text-amber-500" />
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Out of 5.00 ({analytics.totalStarVotes} ratings)
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">
                Positive Highlights Ticked
              </div>
              <div className="mt-2 text-2xl sm:text-3xl font-bold font-mono-tabular text-emerald-700">
                {analytics.totalPositiveTicks}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {analytics.totalImprovementTicks} improvement suggestions
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
              <div className="text-xs font-medium text-slate-500">
                Written Comments
              </div>
              <div className="mt-2 text-2xl sm:text-3xl font-bold font-mono-tabular text-blue-700">
                {analytics.commentsList.length}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Participant suggestions &amp; notes
              </div>
            </div>
          </div>

          {filteredSubmissions.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center space-y-2">
              <p className="text-sm font-semibold text-slate-900">
                No feedback responses match the selected filters
              </p>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Share an event&apos;s Feedback QR link above so participants can submit star ratings, quick checklist ticks, and written recommendations.
              </p>
            </div>
          ) : (
            <>
              {/* Visual Charts Row: Star Distribution + Per-Criterion Bar Chart */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* 1–5 Star Distribution Chart */}
                <section className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-slate-900">
                      Rating Distribution (1–5 Stars)
                    </h3>
                    <span className="text-xs font-mono-tabular text-slate-500">
                      {analytics.totalStarVotes} votes
                    </span>
                  </div>

                  <div className="space-y-3">
                    {([5, 4, 3, 2, 1] as const).map((star) => {
                      const count = analytics.starCounts[star];
                      const pct =
                        analytics.totalStarVotes > 0
                          ? Math.round((count / analytics.totalStarVotes) * 100)
                          : 0;
                      return (
                        <div key={star} className="flex items-center gap-3">
                          <div className="w-14 text-xs font-mono-tabular font-semibold text-slate-700 inline-flex items-center gap-1 shrink-0">
                            <span>{star}</span>
                            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-500" />
                          </div>
                          <div className="flex-1 h-3 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                star >= 4
                                  ? 'bg-emerald-600'
                                  : star === 3
                                  ? 'bg-amber-500'
                                  : 'bg-rose-500'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className="w-16 text-right text-xs font-mono-tabular text-slate-600 shrink-0">
                            {count} ({pct}%)
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* Average Rating Per Evaluation Criterion Chart */}
                <section className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-slate-900">
                      Average Score by Evaluation Area
                    </h3>
                    <span className="text-xs text-slate-500">Scale: 1.0 – 5.0</span>
                  </div>

                  <div className="space-y-3">
                    {analytics.criterionAverages.map((crit) => {
                      const pct = Math.min(100, Math.round((crit.average / 5) * 100));
                      return (
                        <div key={crit.label} className="space-y-1">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-semibold text-slate-800 truncate">
                              {crit.label}
                            </span>
                            <span className="font-mono-tabular font-bold text-slate-900 shrink-0">
                              {crit.average.toFixed(2)} / 5 ({crit.count})
                            </span>
                          </div>
                          <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-blue-600 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>

              {/* Most Frequently Selected Positive & Improvement Areas */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-slate-900 inline-flex items-center gap-2">
                      <ThumbsUp className="w-4 h-4 text-emerald-700" />
                      <span>Most Selected Positive Feedback</span>
                    </h3>
                    <span className="text-xs font-mono-tabular text-emerald-700 font-semibold">
                      {analytics.totalPositiveTicks} ticks
                    </span>
                  </div>

                  {analytics.topPositive.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4">
                      No positive checklist items selected yet.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {analytics.topPositive.map((item) => {
                        const pct = Math.round(
                          (item.count / Math.max(1, analytics.total)) * 100
                        );
                        return (
                          <div key={item.text} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-slate-800 font-medium">
                                {item.text}
                              </span>
                              <span className="font-mono-tabular font-bold text-emerald-700 shrink-0">
                                {item.count} ({pct}%)
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-emerald-50 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-emerald-600"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-slate-900 inline-flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-amber-700" />
                      <span>Most Selected Improvement Areas</span>
                    </h3>
                    <span className="text-xs font-mono-tabular text-amber-700 font-semibold">
                      {analytics.totalImprovementTicks} ticks
                    </span>
                  </div>

                  {analytics.topImprovements.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4">
                      No improvement suggestions ticked in this selection.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {analytics.topImprovements.map((item) => {
                        const pct = Math.round(
                          (item.count / Math.max(1, analytics.total)) * 100
                        );
                        return (
                          <div key={item.text} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-slate-800 font-medium">
                                {item.text}
                              </span>
                              <span className="font-mono-tabular font-bold text-amber-700 shrink-0">
                                {item.count} ({pct}%)
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-amber-50 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-amber-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>

              {/* Separate Results by Event, Facilitator & Session Topic */}
              <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200">
                  <h3 className="text-base font-bold text-slate-900">
                    Evaluation Summary by Event, Facilitator &amp; Topic
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Clearly separates performance metrics across individual sessions, facilitators, and topics.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Event</th>
                        <th className="py-3 px-4">Date</th>
                        <th className="py-3 px-4">Facilitator / Speaker</th>
                        <th className="py-3 px-4">Session / Topic</th>
                        <th className="py-3 px-4 text-right">Responses</th>
                        <th className="py-3 px-4 text-right">Avg Rating</th>
                        <th className="py-3 px-4 text-right">Comments</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {analytics.groupedBreakdown.map((row) => {
                        const avg =
                          row.ratedCount > 0 ? row.ratingSum / row.ratedCount : 0;
                        return (
                          <tr
                            key={`${row.eventId}-${row.facilitatorName}-${row.sessionTopic}`}
                            className="hover:bg-slate-50/70"
                          >
                            <td className="py-3 px-4 font-semibold text-slate-900">
                              {row.eventTitle}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-xs text-slate-600 whitespace-nowrap">
                              {row.eventDate}
                            </td>
                            <td className="py-3 px-4 text-slate-700">
                              {row.facilitatorName}
                            </td>
                            <td className="py-3 px-4 text-slate-700">
                              {row.sessionTopic}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-tabular font-semibold text-slate-900">
                              {row.responses}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-tabular font-bold text-amber-700">
                              {avg > 0 ? `${avg.toFixed(2)} ★` : '—'}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-tabular text-slate-600">
                              {row.commentsCount}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Participant Written Comments & Individual Submissions */}
              <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-base font-bold text-slate-900 inline-flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-blue-700" />
                      <span>
                        Written Comments &amp; Submission Details ({filteredSubmissions.length})
                      </span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Individual participant evaluations ordered from newest to oldest.
                    </p>
                  </div>
                </div>

                <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
                  {filteredSubmissions.map((sub) => (
                    <div
                      key={sub.id}
                      className="px-6 py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4 hover:bg-slate-50/50"
                    >
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-bold text-slate-900">
                            {sub.participantName?.trim() || 'Anonymous Participant'}
                          </span>
                          {sub.participantDepartment && (
                            <span className="text-slate-500">
                              ({sub.participantDepartment})
                            </span>
                          )}
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="text-blue-700 font-semibold">
                            {sub.eventTitle}
                          </span>
                          <span className="text-slate-400 font-mono-tabular">
                            {sub.eventDate}
                          </span>
                          {sub.facilitatorName && (
                            <span className="text-slate-500">
                              · {sub.facilitatorName}
                            </span>
                          )}
                        </div>

                        {sub.writtenComment.trim() ? (
                          <p className="text-sm text-slate-800 leading-relaxed bg-slate-50 border border-slate-200/70 rounded-xl px-3.5 py-2.5">
                            &ldquo;{sub.writtenComment}&rdquo;
                          </p>
                        ) : (
                          <p className="text-xs italic text-slate-400">
                            No written comment provided.
                          </p>
                        )}

                        {sub.selectedStatements.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {sub.selectedStatements.map((st) => (
                              <span
                                key={st.statementId}
                                className={`text-[11px] px-2 py-0.5 rounded-md border font-medium ${
                                  st.sentiment === 'improvement'
                                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                                    : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                }`}
                              >
                                {st.text}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                          <div className="text-sm font-bold font-mono-tabular text-amber-600 inline-flex items-center gap-1">
                            <Star className="w-4 h-4 fill-amber-400 text-amber-500" />
                            <span>
                              {sub.averageRating > 0
                                ? sub.averageRating.toFixed(1)
                                : '—'}
                            </span>
                          </div>
                          <div className="text-[11px] font-mono-tabular text-slate-400">
                            {sub.ratings.length} rated
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={deletingSubmissionId === sub.id}
                          onClick={() => void handleDeleteSubmission(sub.id)}
                          className="min-h-[34px] min-w-[34px] rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center transition-colors disabled:opacity-50"
                          aria-label="Delete feedback submission"
                        >
                          {deletingSubmissionId === sub.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      ) : (
        /* Sub-tab B: Customize Feedback Form & Checklist Statements */
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
            <div className="space-y-1">
              <label
                htmlFor="feedback-config-target"
                className="block text-xs font-bold uppercase tracking-wider text-blue-700"
              >
                Form Customization Target
              </label>
              <div className="flex flex-wrap items-center gap-2.5">
                <select
                  id="feedback-config-target"
                  value={configTargetId}
                  onChange={(e) => {
                    setConfigTargetId(e.target.value);
                    setConfigSaved(false);
                    setConfigError(null);
                  }}
                  className="min-h-[42px] px-3.5 py-2 text-sm bg-slate-50 border border-slate-300 rounded-xl text-slate-900 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="default">
                    Global Default Template (All Events)
                  </option>
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      Event Override: {ev.title} ({ev.eventDate})
                    </option>
                  ))}
                </select>
                {hasCustomOverrideForTarget && (
                  <span className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200">
                    Custom Event Form Active
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setDraftConfig(buildDefaultFeedbackConfig(configTargetId))
                }
                className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Load Recommended Defaults</span>
              </button>
              <button
                type="button"
                disabled={savingConfig}
                onClick={() => void handleSaveFeedbackConfig()}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {savingConfig ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : configSaved ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>{configSaved ? 'Saved!' : 'Save Form Configuration'}</span>
              </button>
            </div>
          </div>

          {configError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
              {configError}
            </div>
          )}

          {/* Intro Note & Written Comment Requirement */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
            <div className="lg:col-span-8">
              <label
                htmlFor="fb-intro-note"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Form Welcome / Intro Note
              </label>
              <input
                id="fb-intro-note"
                type="text"
                maxLength={400}
                value={draftConfig.introNote}
                onChange={(e) =>
                  setDraftConfig((prev) => ({
                    ...prev,
                    introNote: e.target.value,
                  }))
                }
                className="w-full min-h-[42px] px-3.5 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="lg:col-span-4">
              <label className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draftConfig.requireWrittenComment}
                  onChange={(e) =>
                    setDraftConfig((prev) => ({
                      ...prev,
                      requireWrittenComment: e.target.checked,
                    }))
                  }
                  className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                />
                <span className="text-xs font-semibold text-slate-800">
                  Make Written Comments Mandatory
                </span>
              </label>
            </div>
          </div>

          {/* Star Rating Criteria Editor */}
          <div className="pt-4 border-t border-slate-200 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  1–5 Star Rating Areas ({draftConfig.ratingCriteria.length}/12)
                </h3>
                <p className="text-xs text-slate-500">
                  Customize evaluation areas, activate/deactivate questions, or set them as mandatory.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  maxLength={120}
                  value={newCriterionLabel}
                  onChange={(e) => setNewCriterionLabel(e.target.value)}
                  placeholder="New rating area..."
                  className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  type="button"
                  onClick={handleAddCriterion}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Area</span>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {draftConfig.ratingCriteria.map((crit) => (
                <div
                  key={crit.id}
                  className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 p-2.5 rounded-xl border border-slate-200 bg-slate-50/70"
                >
                  <input
                    type="text"
                    maxLength={120}
                    value={crit.label}
                    onChange={(e) =>
                      setDraftConfig((prev) => ({
                        ...prev,
                        ratingCriteria: prev.ratingCriteria.map((c) =>
                          c.id === crit.id ? { ...c, label: e.target.value } : c
                        ),
                      }))
                    }
                    className="flex-1 min-w-[200px] min-h-[36px] px-3 py-1 text-xs sm:text-sm bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2">
                    <input
                      type="checkbox"
                      checked={crit.active}
                      onChange={(e) =>
                        setDraftConfig((prev) => ({
                          ...prev,
                          ratingCriteria: prev.ratingCriteria.map((c) =>
                            c.id === crit.id
                              ? { ...c, active: e.target.checked }
                              : c
                          ),
                        }))
                      }
                    />
                    <span>Active</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2">
                    <input
                      type="checkbox"
                      checked={crit.required}
                      onChange={(e) =>
                        setDraftConfig((prev) => ({
                          ...prev,
                          ratingCriteria: prev.ratingCriteria.map((c) =>
                            c.id === crit.id
                              ? { ...c, required: e.target.checked }
                              : c
                          ),
                        }))
                      }
                    />
                    <span>Mandatory</span>
                  </label>
                  <button
                    type="button"
                    disabled={draftConfig.ratingCriteria.length <= 1}
                    onClick={() =>
                      setDraftConfig((prev) => ({
                        ...prev,
                        ratingCriteria: prev.ratingCriteria.filter(
                          (c) => c.id !== crit.id
                        ),
                      }))
                    }
                    className="min-h-[34px] min-w-[34px] rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center disabled:opacity-40"
                    aria-label={`Delete criterion ${crit.label}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Feedback Categories Manager */}
          <div className="pt-4 border-t border-slate-200 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Feedback Categories ({draftConfig.categories.length}/12)
                </h3>
                <p className="text-xs text-slate-500">
                  Organize quick feedback statements into Positive or Improvement Suggestion groups.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  maxLength={80}
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="New category name..."
                  className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <select
                  value={newCategorySentiment}
                  onChange={(e) =>
                    setNewCategorySentiment(
                      e.target.value === 'improvement'
                        ? 'improvement'
                        : 'positive'
                    )
                  }
                  className="min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="positive">Positive</option>
                  <option value="improvement">Suggestion / Improve</option>
                </select>
                <button
                  type="button"
                  onClick={handleAddCategory}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Category</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {draftConfig.categories.map((cat) => (
                <div
                  key={cat.id}
                  className="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 bg-slate-50/70"
                >
                  <input
                    type="text"
                    maxLength={80}
                    value={cat.name}
                    onChange={(e) =>
                      setDraftConfig((prev) => ({
                        ...prev,
                        categories: prev.categories.map((c) =>
                          c.id === cat.id ? { ...c, name: e.target.value } : c
                        ),
                      }))
                    }
                    className="flex-1 min-h-[34px] px-2.5 py-1 text-xs font-semibold bg-white border border-slate-200 rounded-lg text-slate-900"
                  />
                  <span
                    className={`text-[11px] font-semibold px-2 py-0.5 rounded border shrink-0 ${
                      cat.sentiment === 'improvement'
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    }`}
                  >
                    {cat.sentiment === 'improvement' ? 'Suggestion' : 'Positive'}
                  </span>
                  <button
                    type="button"
                    disabled={draftConfig.categories.length <= 1}
                    onClick={() => handleDeleteCategory(cat.id)}
                    className="min-h-[32px] min-w-[32px] rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center disabled:opacity-40"
                    aria-label={`Delete category ${cat.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Checklist Statements Editor */}
          <div className="pt-4 border-t border-slate-200 space-y-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Quick Feedback Checklist Statements ({draftConfig.statements.length}/40)
              </h3>
              <p className="text-xs text-slate-500">
                Add, edit, delete, activate/deactivate, or mark checklist statements as mandatory.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 p-3 rounded-xl border border-slate-200 bg-slate-50">
              <select
                value={newStatementCategory}
                onChange={(e) => setNewStatementCategory(e.target.value)}
                aria-label="Category for new statement"
                className="min-h-[40px] px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg font-semibold text-slate-800"
              >
                {draftConfig.categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                maxLength={200}
                value={newStatementText}
                onChange={(e) => setNewStatementText(e.target.value)}
                placeholder="Type a new feedback statement..."
                className="flex-1 min-h-[40px] px-3 py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="button"
                onClick={handleAddStatement}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Statement</span>
              </button>
            </div>

            <div className="space-y-2">
              {draftConfig.statements.map((stmt) => (
                <div
                  key={stmt.id}
                  className="flex flex-wrap lg:flex-nowrap items-center gap-2 p-2.5 rounded-xl border border-slate-200 bg-white"
                >
                  <select
                    value={stmt.categoryId}
                    onChange={(e) =>
                      setDraftConfig((prev) => ({
                        ...prev,
                        statements: prev.statements.map((s) =>
                          s.id === stmt.id
                            ? { ...s, categoryId: e.target.value }
                            : s
                        ),
                      }))
                    }
                    className="min-h-[36px] px-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg font-medium text-slate-800"
                  >
                    {draftConfig.categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>

                  <input
                    type="text"
                    maxLength={200}
                    value={stmt.text}
                    onChange={(e) =>
                      setDraftConfig((prev) => ({
                        ...prev,
                        statements: prev.statements.map((s) =>
                          s.id === stmt.id ? { ...s, text: e.target.value } : s
                        ),
                      }))
                    }
                    className="flex-1 min-w-[220px] min-h-[36px] px-3 py-1 text-xs sm:text-sm border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />

                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2">
                    <input
                      type="checkbox"
                      checked={stmt.active}
                      onChange={(e) =>
                        setDraftConfig((prev) => ({
                          ...prev,
                          statements: prev.statements.map((s) =>
                            s.id === stmt.id
                              ? { ...s, active: e.target.checked }
                              : s
                          ),
                        }))
                      }
                    />
                    <span>Active</span>
                  </label>

                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2">
                    <input
                      type="checkbox"
                      checked={stmt.required}
                      onChange={(e) =>
                        setDraftConfig((prev) => ({
                          ...prev,
                          statements: prev.statements.map((s) =>
                            s.id === stmt.id
                              ? { ...s, required: e.target.checked }
                              : s
                          ),
                        }))
                      }
                    />
                    <span>Mandatory</span>
                  </label>

                  <button
                    type="button"
                    onClick={() =>
                      setDraftConfig((prev) => ({
                        ...prev,
                        statements: prev.statements.filter(
                          (s) => s.id !== stmt.id
                        ),
                      }))
                    }
                    className="min-h-[34px] min-w-[34px] rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center"
                    aria-label={`Delete statement ${stmt.text}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
