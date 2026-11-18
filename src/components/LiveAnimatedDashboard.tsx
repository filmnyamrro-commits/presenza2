import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  MapPin,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AttendanceRecord,
  EventRecord,
  LiveBoardAnimationStyle,
  LiveBoardCardLayout,
  LiveBoardDisplayMode,
  LiveBoardSettings,
  LiveBoardSizeScale,
  LiveBoardThemeId,
  OrganizationBranding,
} from '../types';
import {
  computeAdaptiveGridMetrics,
  DEFAULT_LIVE_BOARD_SETTINGS,
  LIVE_BOARD_THEMES,
  mergeLiveBoardSettings,
  sortAttendancesChronologically,
} from '../utils/liveDashboardLayout';

interface LiveAnimatedDashboardProps {
  events: EventRecord[];
  attendances: AttendanceRecord[];
  selectedEventFilter: string;
  onChangeEventFilter: (eventId: string) => void;
  branding?: OrganizationBranding | null;
  dashboardBgUrl?: string | null;
  dashboardBgOpacity?: number;
  boardSettings: LiveBoardSettings;
  onSaveBoardSettings: (next: LiveBoardSettings) => Promise<void>;
  newlyArrivedIds: Set<string>;
  latestArrival: AttendanceRecord | null;
  onPreviewPhoto: (record: AttendanceRecord) => void;
  isProjectorOpen: boolean;
  onSetProjectorOpen: (open: boolean) => void;
  voiceEnabled?: boolean;
  dashboardVoiceMuted?: boolean;
  onToggleVoiceMute?: () => void;
  speakingParticipantName?: string | null;
}

const ANIMATION_STYLE_OPTIONS: {
  id: LiveBoardAnimationStyle;
  label: string;
}[] = [
  { id: 'zoom-bounce', label: 'Zoom + Bounce' },
  { id: 'slide-up', label: 'Slide Up + Fade' },
  { id: 'slide-side', label: 'Slide In + Fade' },
  { id: 'fade-scale', label: 'Smooth Scale' },
];

const CARD_LAYOUT_OPTIONS: {
  id: LiveBoardCardLayout;
  label: string;
}[] = [
  { id: 'portrait-card', label: 'Portrait Card' },
  { id: 'horizontal-tile', label: 'Horizontal Tile' },
  { id: 'compact-badge', label: 'Compact Badge' },
];

const DISPLAY_MODE_OPTIONS: {
  id: LiveBoardDisplayMode;
  label: string;
  desc: string;
}[] = [
  {
    id: 'fit',
    label: 'Fit All Participants',
    desc: 'Dynamically scales cards so everyone fits cleanly on one screen',
  },
  {
    id: 'auto-paginate',
    label: 'Automatic Pagination',
    desc: 'Splits large groups into balanced full-screen pages',
  },
  {
    id: 'rotating',
    label: 'Rotating Display',
    desc: 'Automatically cycles pages on a timer for TVs & projectors',
  },
  {
    id: 'manual',
    label: 'Manual Page Navigation',
    desc: 'Browse pages manually with Previous / Next controls',
  },
];

const SCALE_OPTIONS: { id: LiveBoardSizeScale; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'sm', label: 'Small' },
  { id: 'md', label: 'Medium' },
  { id: 'lg', label: 'Large' },
  { id: 'xl', label: 'XL' },
];

export default function LiveAnimatedDashboard({
  events,
  attendances,
  selectedEventFilter,
  onChangeEventFilter,
  branding,
  dashboardBgUrl,
  dashboardBgOpacity = 25,
  boardSettings,
  onSaveBoardSettings,
  newlyArrivedIds,
  latestArrival,
  onPreviewPhoto,
  isProjectorOpen,
  onSetProjectorOpen,
  voiceEnabled = false,
  dashboardVoiceMuted = false,
  onToggleVoiceMute,
  speakingParticipantName,
}: LiveAnimatedDashboardProps) {
  const prefersReducedMotion = useReducedMotion();
  const [draftSettings, setDraftSettings] = useState<LiveBoardSettings>(() =>
    mergeLiveBoardSettings(boardSettings)
  );
  const [showCustomizer, setShowCustomizer] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState(0);
  const [rotationPaused, setRotationPaused] = useState(false);
  const [clockLabel, setClockLabel] = useState(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );

  const rootOverlayRef = useRef<HTMLDivElement | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({
    width: 1120,
    height: 600,
  });

  useEffect(() => {
    setDraftSettings(mergeLiveBoardSettings(boardSettings));
  }, [boardSettings]);

  // Live clock for projector header
  useEffect(() => {
    const updateClock = () => {
      setClockLabel(
        new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: isProjectorOpen ? '2-digit' : undefined,
        })
      );
    };
    updateClock();
    const timer = window.setInterval(updateClock, isProjectorOpen ? 1000 : 15000);
    return () => window.clearInterval(timer);
  }, [isProjectorOpen]);

  // Observe grid viewport size for automatic responsive sizing
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize((prev) =>
          Math.abs(prev.width - rect.width) > 4 ||
          Math.abs(prev.height - rect.height) > 4
            ? { width: Math.floor(rect.width), height: Math.floor(rect.height) }
            : prev
        );
      }
    };

    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isProjectorOpen, showCustomizer]);

  // Sync browser Fullscreen API cleanly when exiting via Escape
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && isProjectorOpen) {
        // Keep overlay open if opened inside iframe without native fullscreen,
        // or user can press Escape / Exit button.
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isProjectorOpen) {
        onSetProjectorOpen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isProjectorOpen, onSetProjectorOpen]);

  const enterProjectorMode = async () => {
    setShowCustomizer(false);
    onSetProjectorOpen(true);
    window.setTimeout(async () => {
      try {
        if (
          rootOverlayRef.current &&
          document.fullscreenEnabled &&
          !document.fullscreenElement
        ) {
          await rootOverlayRef.current.requestFullscreen();
        }
      } catch {
        // Fallback: fixed full-viewport presentation overlay works seamlessly in iframes
      }
    }, 40);
  };

  const exitProjectorMode = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore fullscreen exit errors
    }
    onSetProjectorOpen(false);
  };

  // Active event context
  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventFilter) ?? null,
    [events, selectedEventFilter]
  );

  // Filter attendances by selected event and sort strictly chronologically by confirmed serverTimestamp + id tie-breaker
  const rankedAttendances = useMemo(() => {
    const filtered =
      selectedEventFilter === 'all'
        ? attendances
        : attendances.filter((a) => a.eventId === selectedEventFilter);
    return sortAttendancesChronologically(filtered);
  }, [attendances, selectedEventFilter]);

  const counts = useMemo(() => {
    const total = rankedAttendances.length;
    const onTime = rankedAttendances.filter((a) => a.status === 'On Time').length;
    const late = rankedAttendances.filter((a) => a.status === 'Late').length;
    return { total, onTime, late };
  }, [rankedAttendances]);

  const activeSettings = draftSettings;
  const theme = LIVE_BOARD_THEMES[activeSettings.backgroundTheme];
  const animationsDisabled =
    activeSettings.disableAnimations || Boolean(prefersReducedMotion);

  const metrics = useMemo(
    () =>
      computeAdaptiveGridMetrics({
        totalCount: rankedAttendances.length,
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        settings: activeSettings,
      }),
    [rankedAttendances.length, containerSize.width, containerSize.height, activeSettings]
  );

  const totalPages =
    activeSettings.displayMode === 'fit'
      ? 1
      : Math.max(1, Math.ceil(rankedAttendances.length / metrics.pageSize));

  useEffect(() => {
    setCurrentPage((prev) => Math.min(prev, Math.max(0, totalPages - 1)));
  }, [totalPages]);

  // Jump automatically to the page showing a newly arrived participant so live check-ins are visible immediately
  useEffect(() => {
    if (!latestArrival || activeSettings.displayMode === 'fit') return;
    if (
      selectedEventFilter !== 'all' &&
      latestArrival.eventId !== selectedEventFilter
    ) {
      return;
    }
    const idx = rankedAttendances.findIndex((r) => r.id === latestArrival.id);
    if (idx >= 0) {
      const targetPage = Math.floor(idx / metrics.pageSize);
      setCurrentPage(targetPage);
    }
  }, [
    latestArrival,
    rankedAttendances,
    metrics.pageSize,
    activeSettings.displayMode,
    selectedEventFilter,
  ]);

  // Auto-rotation interval for Rotating Display mode
  useEffect(() => {
    if (
      activeSettings.displayMode !== 'rotating' ||
      totalPages <= 1 ||
      rotationPaused
    ) {
      return;
    }
    const ms = Math.max(4000, activeSettings.rotationIntervalSec * 1000);
    const interval = window.setInterval(() => {
      setCurrentPage((prev) => (prev + 1) % totalPages);
    }, ms);
    return () => window.clearInterval(interval);
  }, [
    activeSettings.displayMode,
    activeSettings.rotationIntervalSec,
    totalPages,
    rotationPaused,
  ]);

  const visibleSlice = useMemo(() => {
    if (activeSettings.displayMode === 'fit') {
      return rankedAttendances.map((rec, idx) => ({
        rec,
        rank: idx + 1,
      }));
    }
    const start = currentPage * metrics.pageSize;
    return rankedAttendances
      .slice(start, start + metrics.pageSize)
      .map((rec, idx) => ({
        rec,
        rank: start + idx + 1,
      }));
  }, [
    rankedAttendances,
    activeSettings.displayMode,
    currentPage,
    metrics.pageSize,
  ]);

  const handleSave = async () => {
    setSavingSettings(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await onSaveBoardSettings(mergeLiveBoardSettings(draftSettings));
      setSaveSuccess(true);
      window.setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Unable to save display settings.'
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const handleResetDefaults = () => {
    setDraftSettings({ ...DEFAULT_LIVE_BOARD_SETTINGS });
  };

  // Build entrance animation props per style
  const getEntranceConfig = (isNewArrival: boolean) => {
    if (!isNewArrival || animationsDisabled) {
      return {
        initial: false as const,
        animate: { opacity: 1, scale: 1, x: 0, y: 0 },
        transition: { duration: 0 },
      };
    }

    const durSec = Math.max(
      0.25,
      Math.min(1.5, activeSettings.animationDurationMs / 1000)
    );

    switch (activeSettings.animationStyle) {
      case 'zoom-bounce':
        return {
          initial: { opacity: 0, scale: 0.58, y: 18 },
          animate: { opacity: 1, scale: 1, y: 0 },
          transition: {
            type: 'spring' as const,
            stiffness: 320,
            damping: 18,
            mass: 0.85,
            duration: durSec,
          },
        };
      case 'slide-up':
        return {
          initial: { opacity: 0, y: 34, scale: 0.94 },
          animate: { opacity: 1, y: 0, scale: 1 },
          transition: {
            duration: durSec,
            ease: [0.22, 1, 0.36, 1] as const,
          },
        };
      case 'slide-side':
        return {
          initial: { opacity: 0, x: -40, scale: 0.94 },
          animate: { opacity: 1, x: 0, scale: 1 },
          transition: {
            duration: durSec,
            ease: [0.22, 1, 0.36, 1] as const,
          },
        };
      case 'fade-scale':
      default:
        return {
          initial: { opacity: 0, scale: 0.85 },
          animate: { opacity: 1, scale: 1 },
          transition: {
            duration: durSec,
            ease: 'easeOut' as const,
          },
        };
    }
  };

  const isBannerVisible =
    Boolean(latestArrival) &&
    newlyArrivedIds.has(latestArrival?.id ?? '') &&
    (selectedEventFilter === 'all' ||
      latestArrival?.eventId === selectedEventFilter);

  const bannerRank = useMemo(() => {
    if (!latestArrival) return null;
    const idx = rankedAttendances.findIndex((r) => r.id === latestArrival.id);
    return idx >= 0 ? idx + 1 : null;
  }, [latestArrival, rankedAttendances]);

  const orgName = branding?.organizationName?.trim() || '';

  return (
    <div
      ref={rootOverlayRef}
      className={
        isProjectorOpen
          ? `fixed inset-0 z-[70] flex flex-col overflow-hidden ${theme.canvasBg}`
          : `relative rounded-2xl border border-slate-200 overflow-hidden flex flex-col ${theme.canvasBg}`
      }
      style={isProjectorOpen ? undefined : { minHeight: '76vh' }}
    >
      {/* Optional JPEG Portrait Background Photo */}
      {dashboardBgUrl && (
        <img
          src={dashboardBgUrl}
          alt=""
          aria-hidden="true"
          style={{
            opacity: Math.min(1, Math.max(0, dashboardBgOpacity / 100)),
          }}
          className="absolute inset-0 w-full h-full object-cover object-top pointer-events-none select-none transition-opacity duration-200"
        />
      )}

      {/* Top Display Header */}
      <header
        className={`relative z-20 px-4 sm:px-6 py-3.5 border-b backdrop-blur-sm flex flex-wrap items-center justify-between gap-3 shrink-0 ${theme.headerBg} ${theme.headerBorder}`}
      >
        <div className="flex items-center gap-3.5 min-w-0">
          {branding?.logoDataUrl && (
            <img
              src={branding.logoDataUrl}
              alt={orgName ? `${orgName} logo` : 'Organization logo'}
              className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl object-contain bg-white border border-slate-200 p-0.5 shrink-0"
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {orgName && (
                <span
                  className={`text-[11px] font-bold uppercase tracking-wider ${
                    theme.isDark ? 'text-sky-300' : 'text-blue-700'
                  }`}
                >
                  {orgName}
                </span>
              )}
              {orgName && (
                <span aria-hidden="true" className={theme.mutedText}>
                  ·
                </span>
              )}
              <span
                className={`text-[11px] font-bold uppercase tracking-wider ${
                  theme.isDark ? 'text-emerald-400' : 'text-emerald-700'
                }`}
              >
                LIVE ATTENDANCE BOARD
              </span>
            </div>

            <h2
              className={`text-lg sm:text-xl lg:text-2xl font-display font-extrabold tracking-tight truncate ${theme.headingText}`}
            >
              {selectedEvent ? selectedEvent.title : 'All Active Sessions'}
            </h2>

            <div
              className={`mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs ${theme.mutedText}`}
            >
              {selectedEvent ? (
                <>
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" />
                    <span>{selectedEvent.venue}</span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">
                    {selectedEvent.eventDate}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">
                    Start {selectedEvent.startTime} (Cutoff{' '}
                    {selectedEvent.lateCutoffTime})
                  </span>
                </>
              ) : (
                <span>Chronological real-time check-in monitor</span>
              )}
            </div>
          </div>
        </div>

        {/* Right Counters + Action Controls */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 shrink-0">
          {/* Unboxed Tabular Stats */}
          <div
            className={`flex items-center gap-3 text-xs sm:text-sm font-mono-tabular px-2 py-1 ${theme.headingText}`}
          >
            <span>
              <strong className="font-bold">{counts.total}</strong>{' '}
              <span className={theme.mutedText}>Checked In</span>
            </span>
            <span aria-hidden="true" className={theme.mutedText}>
              ·
            </span>
            <span className={theme.onTimeText}>
              <strong className="font-bold">{counts.onTime}</strong> On Time
            </span>
            <span aria-hidden="true" className={theme.mutedText}>
              ·
            </span>
            <span className={theme.lateText}>
              <strong className="font-bold">{counts.late}</strong> Late
            </span>
            <span aria-hidden="true" className={`hidden sm:inline ${theme.mutedText}`}>
              ·
            </span>
            <span className={`hidden sm:inline font-semibold ${theme.mutedText}`}>
              {clockLabel}
            </span>
          </div>

          {/* Session Filter (hidden only in clean Projector Mode unless multiple events? Keep concise in standard view, optional quick switch in non-projector) */}
          {!isProjectorOpen && (
            <select
              value={selectedEventFilter}
              onChange={(e) => {
                setCurrentPage(0);
                onChangeEventFilter(e.target.value);
              }}
              aria-label="Select session for Live Animated Dashboard"
              className="min-h-[38px] max-w-[210px] px-3 py-1.5 text-xs font-semibold rounded-xl border border-slate-300 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="all">All Sessions ({events.length})</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.title}
                </option>
              ))}
            </select>
          )}

          {/* Voice Quick Status / Mute Toggle */}
          {voiceEnabled && onToggleVoiceMute && (
            <button
              type="button"
              onClick={onToggleVoiceMute}
              className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                theme.isDark
                  ? 'border-slate-700 bg-slate-800/90 text-slate-100 hover:bg-slate-700'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
              }`}
              title="Mute or unmute AI voice announcements"
            >
              {dashboardVoiceMuted ? (
                <>
                  <VolumeX className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">Muted</span>
                </>
              ) : (
                <>
                  <Volume2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="hidden md:inline max-w-[120px] truncate">
                    {speakingParticipantName
                      ? speakingParticipantName
                      : 'Voice On'}
                  </span>
                </>
              )}
            </button>
          )}

          {/* Display Customizer Toggle */}
          {!isProjectorOpen && (
            <button
              type="button"
              onClick={() => setShowCustomizer((v) => !v)}
              className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                showCustomizer
                  ? 'border-blue-600 bg-blue-700 text-white'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Display Settings</span>
            </button>
          )}

          {/* Projector Full-Screen Toggle */}
          <button
            type="button"
            onClick={() =>
              void (isProjectorOpen
                ? exitProjectorMode()
                : enterProjectorMode())
            }
            className={`min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
              isProjectorOpen
                ? theme.isDark
                  ? 'border border-slate-600 bg-slate-800 hover:bg-slate-700 text-white'
                  : 'border border-slate-300 bg-white hover:bg-slate-100 text-slate-900'
                : 'bg-slate-900 hover:bg-slate-800 text-white'
            }`}
          >
            {isProjectorOpen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span>Exit Projector</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Projector Mode</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Collapsible Admin Customization Drawer */}
      {showCustomizer && !isProjectorOpen && (
        <section
          aria-label="Live board visual customization"
          className="relative z-20 bg-white border-b border-slate-200 px-4 sm:px-6 py-4 space-y-4 shrink-0"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Live Animated Dashboard Customization
              </h3>
              <p className="text-xs text-slate-500">
                Changes preview live below. Save settings to sync across projector and admin screens.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleResetDefaults}
                className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
              <button
                type="button"
                disabled={savingSettings}
                onClick={() => void handleSave()}
                className="min-h-[34px] px-3.5 py-1 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {savingSettings ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : saveSuccess ? (
                  <Check className="w-3.5 h-3.5 text-emerald-300" />
                ) : null}
                <span>{saveSuccess ? 'Saved' : 'Save Settings'}</span>
              </button>
              <button
                type="button"
                onClick={() => setShowCustomizer(false)}
                className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close display settings"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {saveError && (
            <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
              {saveError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            {/* Animation Style */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                Entrance Animation
              </label>
              <select
                value={draftSettings.animationStyle}
                onChange={(e) =>
                  setDraftSettings((s) => ({
                    ...s,
                    animationStyle: e.target.value as LiveBoardAnimationStyle,
                  }))
                }
                className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
              >
                {ANIMATION_STYLE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Animation Duration */}
            <div>
              <label className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                <span>Animation Duration</span>
                <span className="font-mono-tabular text-slate-900">
                  {draftSettings.animationDurationMs}ms
                </span>
              </label>
              <input
                type="range"
                min={250}
                max={1400}
                step={50}
                value={draftSettings.animationDurationMs}
                onChange={(e) =>
                  setDraftSettings((s) => ({
                    ...s,
                    animationDurationMs: Number(e.target.value),
                  }))
                }
                className="w-full accent-blue-700 cursor-pointer mt-2"
              />
            </div>

            {/* Card Layout */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                Card Layout
              </label>
              <select
                value={draftSettings.cardLayout}
                onChange={(e) =>
                  setDraftSettings((s) => ({
                    ...s,
                    cardLayout: e.target.value as LiveBoardCardLayout,
                  }))
                }
                className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
              >
                {CARD_LAYOUT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Background Theme */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                Background Theme
              </label>
              <select
                value={draftSettings.backgroundTheme}
                onChange={(e) =>
                  setDraftSettings((s) => ({
                    ...s,
                    backgroundTheme: e.target.value as LiveBoardThemeId,
                  }))
                }
                className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
              >
                {(Object.keys(LIVE_BOARD_THEMES) as LiveBoardThemeId[]).map(
                  (tid) => (
                    <option key={tid} value={tid}>
                      {LIVE_BOARD_THEMES[tid].label}
                    </option>
                  )
                )}
              </select>
            </div>

            {/* Display & Overflow Strategy */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                Screen Fit &amp; Pagination
              </label>
              <select
                value={draftSettings.displayMode}
                onChange={(e) => {
                  setCurrentPage(0);
                  setDraftSettings((s) => ({
                    ...s,
                    displayMode: e.target.value as LiveBoardDisplayMode,
                  }));
                }}
                className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
              >
                {DISPLAY_MODE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Grid Columns (Auto vs Manual) */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                Grid Columns
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={draftSettings.columnsMode}
                  onChange={(e) =>
                    setDraftSettings((s) => ({
                      ...s,
                      columnsMode: e.target.value as 'auto' | 'manual',
                    }))
                  }
                  className="flex-1 min-h-[38px] px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
                >
                  <option value="auto">Auto ({metrics.columns} cols)</option>
                  <option value="manual">Manual</option>
                </select>
                {draftSettings.columnsMode === 'manual' && (
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={draftSettings.manualColumns}
                    onChange={(e) =>
                      setDraftSettings((s) => ({
                        ...s,
                        manualColumns: Math.min(
                          10,
                          Math.max(1, Number(e.target.value) || 1)
                        ),
                      }))
                    }
                    aria-label="Manual column count"
                    className="w-16 min-h-[38px] px-2.5 py-1.5 text-xs font-mono-tabular bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
                  />
                )}
              </div>
            </div>

            {/* Photo & Font Size Overrides */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                  Photo Size
                </label>
                <select
                  value={draftSettings.photoSize}
                  onChange={(e) =>
                    setDraftSettings((s) => ({
                      ...s,
                      photoSize: e.target.value as LiveBoardSizeScale,
                    }))
                  }
                  className="w-full min-h-[38px] px-2 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
                >
                  {SCALE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                  Font Size
                </label>
                <select
                  value={draftSettings.fontSize}
                  onChange={(e) =>
                    setDraftSettings((s) => ({
                      ...s,
                      fontSize: e.target.value as LiveBoardSizeScale,
                    }))
                  }
                  className="w-full min-h-[38px] px-2 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900"
                >
                  {SCALE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Rotation Interval + Low-Spec Reduced Motion */}
            <div className="flex flex-col justify-between gap-2">
              {draftSettings.displayMode === 'rotating' && (
                <div>
                  <label className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-slate-600 mb-1">
                    <span>Rotate Every</span>
                    <span className="font-mono-tabular text-slate-900">
                      {draftSettings.rotationIntervalSec}s
                    </span>
                  </label>
                  <input
                    type="range"
                    min={4}
                    max={60}
                    step={1}
                    value={draftSettings.rotationIntervalSec}
                    onChange={(e) =>
                      setDraftSettings((s) => ({
                        ...s,
                        rotationIntervalSec: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-blue-700 cursor-pointer"
                  />
                </div>
              )}

              <label className="min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={draftSettings.disableAnimations}
                  onChange={(e) =>
                    setDraftSettings((s) => ({
                      ...s,
                      disableAnimations: e.target.checked,
                    }))
                  }
                  className="w-4 h-4 accent-blue-700 rounded"
                />
                <span>Low-Spec / Disable Animations</span>
              </label>
            </div>
          </div>
        </section>
      )}

      {/* Brief Non-Intrusive Arrival Spotlight Banner (when a new participant checks in) */}
      <AnimatePresence>
        {isBannerVisible && latestArrival && (
          <motion.div
            key={`banner-${latestArrival.id}`}
            initial={
              animationsDisabled ? false : { opacity: 0, y: -16 }
            }
            animate={{ opacity: 1, y: 0 }}
            exit={animationsDisabled ? undefined : { opacity: 0, y: -12 }}
            transition={{ duration: 0.25 }}
            className={`relative z-20 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 shrink-0 shadow-sm ${theme.bannerBg} ${theme.bannerText}`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <img
                src={latestArrival.photoDataUrl}
                alt={latestArrival.fullName}
                className="w-9 h-9 rounded-full object-cover border-2 border-white/80 shrink-0"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs sm:text-sm font-bold truncate">
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <span className="truncate">
                    Welcome, {latestArrival.fullName}!
                  </span>
                </div>
                <div className="text-[11px] opacity-90 truncate">
                  {bannerRank ? `Rank #${bannerRank} · ` : ''}
                  {latestArrival.classDepartment} · Checked in at{' '}
                  {latestArrival.checkInTime}
                </div>
              </div>
            </div>
            <span className="text-xs font-mono-tabular font-bold uppercase tracking-wider shrink-0 opacity-90">
              {latestArrival.status}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Responsive Grid Viewport */}
      <div
        ref={gridContainerRef}
        className={`relative z-10 flex-1 min-h-0 p-3 sm:p-5 ${
          metrics.requiresScroll || activeSettings.displayMode === 'fit'
            ? metrics.requiresScroll
              ? 'overflow-y-auto'
              : 'overflow-hidden'
            : 'overflow-hidden'
        }`}
      >
        {rankedAttendances.length === 0 ? (
          <div className="h-full min-h-[340px] flex flex-col items-center justify-center text-center px-6">
            <div
              className={`w-14 h-14 rounded-2xl border flex items-center justify-center mb-4 ${theme.cardBg} ${theme.cardBorder}`}
            >
              <Users className={`w-7 h-7 ${theme.mutedText}`} />
            </div>
            <h3 className={`text-lg sm:text-xl font-bold ${theme.headingText}`}>
              Waiting for participants to check in
            </h3>
            <p className={`mt-1.5 text-sm max-w-md ${theme.mutedText}`}>
              Participants appear here automatically in exact chronological arrival order (#1, #2, #3...) as soon as they scan the QR code and submit.
            </p>
          </div>
        ) : (
          <LayoutGroup id="live-attendance-grid">
            <div
              className="grid w-full items-stretch content-start"
              style={{
                gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`,
                gap: `${metrics.gapPx}px`,
              }}
            >
              {visibleSlice.map(({ rec, rank }) => {
                const isNewArrival = newlyArrivedIds.has(rec.id);
                const entrance = getEntranceConfig(isNewArrival);
                const isLate = rec.status === 'Late';

                return (
                  <motion.article
                    key={rec.id}
                    layout={!animationsDisabled}
                    initial={entrance.initial}
                    animate={entrance.animate}
                    transition={{
                      ...entrance.transition,
                      layout: animationsDisabled
                        ? { duration: 0 }
                        : { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
                    }}
                    style={{
                      padding: `${metrics.paddingPx}px`,
                      minHeight: `${metrics.cellHeightPx}px`,
                    }}
                    className={`rounded-2xl border transition-colors flex ${
                      isNewArrival
                        ? `${theme.spotlightBorder} ${theme.spotlightGlow}`
                        : `${theme.cardBg} ${theme.cardBorder}`
                    } ${
                      activeSettings.cardLayout === 'portrait-card'
                        ? 'flex-col items-center justify-between text-center'
                        : 'flex-row items-center gap-3'
                    }`}
                  >
                    {activeSettings.cardLayout === 'portrait-card' ? (
                      <>
                        {/* Top Rank + Status */}
                        <div className="w-full flex items-center justify-between gap-2">
                          <span
                            style={{ fontSize: `${metrics.rankPx}px` }}
                            className={`px-2 py-0.5 rounded-md font-mono-tabular font-bold leading-tight ${theme.rankBadgeBg} ${theme.rankBadgeText}`}
                          >
                            Rank {rank}
                          </span>
                          <span
                            style={{ fontSize: `${Math.max(10, metrics.timePx - 1)}px` }}
                            className={`inline-flex items-center gap-1 font-semibold ${
                              isLate ? theme.lateText : theme.onTimeText
                            }`}
                          >
                            {isLate ? (
                              <Clock className="w-3 h-3 shrink-0" />
                            ) : (
                              <CheckCircle2 className="w-3 h-3 shrink-0" />
                            )}
                            <span>{rec.status}</span>
                          </span>
                        </div>

                        {/* Participant Photo */}
                        <button
                          type="button"
                          onClick={() => onPreviewPhoto(rec)}
                          style={{
                            width: `${metrics.photoPx}px`,
                            height: `${metrics.photoPx}px`,
                          }}
                          className="my-1.5 rounded-2xl overflow-hidden border border-slate-300/60 bg-slate-200/40 shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          aria-label={`View photo of ${rec.fullName}`}
                        >
                          <img
                            src={rec.photoDataUrl}
                            alt={rec.fullName}
                            decoding="async"
                            loading="eager"
                            className="w-full h-full object-cover"
                          />
                        </button>

                        {/* Name, Department & Check-In Time */}
                        <div className="w-full min-w-0 space-y-0.5">
                          <div
                            style={{ fontSize: `${metrics.namePx}px` }}
                            className={`font-display font-bold leading-snug truncate ${theme.nameText}`}
                            title={rec.fullName}
                          >
                            {rec.fullName}
                          </div>
                          <div
                            style={{ fontSize: `${metrics.deptPx}px` }}
                            className={`leading-snug truncate ${theme.deptText}`}
                            title={rec.classDepartment}
                          >
                            {rec.classDepartment}
                          </div>
                          <div
                            style={{ fontSize: `${metrics.timePx}px` }}
                            className={`font-mono-tabular font-semibold pt-0.5 ${theme.timeText}`}
                          >
                            {rec.checkInTime}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Horizontal Tile or Compact Badge */}
                        <div className="relative shrink-0">
                          <button
                            type="button"
                            onClick={() => onPreviewPhoto(rec)}
                            style={{
                              width: `${metrics.photoPx}px`,
                              height: `${metrics.photoPx}px`,
                            }}
                            className="rounded-xl overflow-hidden border border-slate-300/60 bg-slate-200/40 block focus:outline-none focus:ring-2 focus:ring-blue-500"
                            aria-label={`View photo of ${rec.fullName}`}
                          >
                            <img
                              src={rec.photoDataUrl}
                              alt={rec.fullName}
                              decoding="async"
                              loading="eager"
                              className="w-full h-full object-cover"
                            />
                          </button>
                          <span
                            style={{ fontSize: `${Math.max(9, metrics.rankPx - 1)}px` }}
                            className={`absolute -top-1.5 -left-1.5 px-1.5 py-0.5 rounded-md font-mono-tabular font-bold leading-none shadow-xs ${theme.rankBadgeBg} ${theme.rankBadgeText}`}
                          >
                            #{rank}
                          </span>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div
                            style={{ fontSize: `${metrics.namePx}px` }}
                            className={`font-display font-bold leading-snug truncate ${theme.nameText}`}
                            title={rec.fullName}
                          >
                            {rec.fullName}
                          </div>
                          <div
                            style={{ fontSize: `${metrics.deptPx}px` }}
                            className={`leading-snug truncate ${theme.deptText}`}
                            title={rec.classDepartment}
                          >
                            {rec.classDepartment}
                          </div>
                        </div>

                        <div className="text-right shrink-0 space-y-0.5">
                          <div
                            style={{ fontSize: `${metrics.timePx}px` }}
                            className={`font-mono-tabular font-bold ${theme.timeText}`}
                          >
                            {rec.checkInTime}
                          </div>
                          {activeSettings.cardLayout === 'horizontal-tile' && (
                            <div
                              style={{ fontSize: `${Math.max(10, metrics.timePx - 1)}px` }}
                              className={`font-semibold ${
                                isLate ? theme.lateText : theme.onTimeText
                              }`}
                            >
                              {rec.status}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </motion.article>
                );
              })}
            </div>
          </LayoutGroup>
        )}
      </div>

      {/* Bottom Pagination / Rotation Footer (shown when multi-page or rotating) */}
      {(totalPages > 1 || activeSettings.displayMode !== 'fit') && (
        <footer
          className={`relative z-20 px-4 sm:px-6 py-2.5 border-t backdrop-blur-sm flex flex-wrap items-center justify-between gap-3 shrink-0 ${theme.headerBg} ${theme.headerBorder}`}
        >
          <div className={`text-xs font-mono-tabular ${theme.mutedText}`}>
            Page{' '}
            <strong className={theme.headingText}>{currentPage + 1}</strong> of{' '}
            <strong className={theme.headingText}>{totalPages}</strong> ·{' '}
            Showing {visibleSlice.length} of {rankedAttendances.length} participants
          </div>

          <div className="flex items-center gap-2">
            {activeSettings.displayMode === 'rotating' && totalPages > 1 && (
              <button
                type="button"
                onClick={() => setRotationPaused((p) => !p)}
                className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 ${
                  theme.isDark
                    ? 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                    : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                }`}
              >
                {rotationPaused ? (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Resume ({activeSettings.rotationIntervalSec}s)</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    <span>Auto-Rotating ({activeSettings.rotationIntervalSec}s)</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              disabled={totalPages <= 1}
              onClick={() =>
                setCurrentPage((p) => (p - 1 + totalPages) % totalPages)
              }
              className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40 ${
                theme.isDark
                  ? 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
              }`}
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Prev</span>
            </button>

            <div className="hidden sm:flex items-center gap-1">
              {Array.from({ length: totalPages }).map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCurrentPage(idx)}
                  aria-label={`Go to page ${idx + 1}`}
                  className={`min-w-[28px] h-7 px-2 rounded-lg text-xs font-mono-tabular font-semibold transition-colors ${
                    idx === currentPage
                      ? `${theme.rankBadgeBg} ${theme.rankBadgeText}`
                      : theme.isDark
                      ? 'text-slate-300 hover:bg-slate-800'
                      : 'text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {idx + 1}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={totalPages <= 1}
              onClick={() => setCurrentPage((p) => (p + 1) % totalPages)}
              className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40 ${
                theme.isDark
                  ? 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
              }`}
              aria-label="Next page"
            >
              <span>Next</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
