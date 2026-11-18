/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import AdminConsole, { type AdminSectionTab } from './components/AdminConsole';
import DeviceAuthGate from './components/DeviceAuthGate';
import ErrorBoundary from './components/ErrorBoundary';
import ParticipantCheckIn from './components/ParticipantCheckIn';
import ParticipantFeedback from './components/ParticipantFeedback';
import { auth, db, handleFirestoreError } from './firebase';
import { OperationType, type OrganizationBranding } from './types';

type ViewMode = 'checkin' | 'feedback' | 'admin';

function readInitialEventId(): string | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('event');
  return raw ? raw.trim() : null;
}

function readAdminSectionFromLocation(): AdminSectionTab {
  if (window.location.hash === '#admin/live-board') return 'live-board';
  if (window.location.hash === '#admin/feedback') return 'feedback';
  if (window.location.hash === '#admin/certificates') return 'certificates';
  if (window.location.hash === '#admin/voice') return 'voice';
  return 'attendance';
}

function isAdminLocation(): boolean {
  const path = window.location.pathname.replace(/\/+$/, '');
  return (
    window.location.hash.startsWith('#admin') ||
    path === '/admin'
  );
}

function isFeedbackQueryLocation(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'feedback' || window.location.hash === '#feedback';
}

function readInitialView(): ViewMode {
  if (isFeedbackQueryLocation()) {
    return 'feedback';
  }
  if (isAdminLocation() && !readInitialEventId()) {
    return 'admin';
  }
  return 'checkin';
}

export default function App() {
  const [view, setView] = useState<ViewMode>(readInitialView);
  const [adminSection, setAdminSection] = useState<AdminSectionTab>(
    readAdminSectionFromLocation
  );
  const [requestedEventId, setRequestedEventId] = useState<string | null>(
    readInitialEventId
  );
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [branding, setBranding] = useState<OrganizationBranding | null>(null);

  // When a participant enters via QR link (/?event=<id> or /?view=feedback&event=<id>), hide Admin menu controls
  const isQrParticipantView = Boolean(requestedEventId);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'branding', 'default'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as {
            organizationName?: string;
            logoDataUrl?: string;
          };
          setBranding({
            organizationName: (data.organizationName || '').trim(),
            logoDataUrl: data.logoDataUrl || '',
          });
        } else {
          setBranding(null);
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'branding/default');
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const syncFromLocation = () => {
      const ev = readInitialEventId();
      setRequestedEventId(ev);
      if (isFeedbackQueryLocation()) {
        setView('feedback');
      } else if (isAdminLocation() && !ev) {
        setView('admin');
        setAdminSection(readAdminSectionFromLocation());
      } else {
        setView('checkin');
      }
    };
    window.addEventListener('hashchange', syncFromLocation);
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  const navigateToView = (
    nextView: ViewMode,
    nextAdminSection?: AdminSectionTab
  ) => {
    setView(nextView);
    if (nextView === 'admin') {
      const targetSec = nextAdminSection ?? adminSection;
      setAdminSection(targetSec);
      const hash =
        targetSec === 'live-board'
          ? '#admin/live-board'
          : targetSec === 'feedback'
          ? '#admin/feedback'
          : targetSec === 'certificates'
          ? '#admin/certificates'
          : targetSec === 'voice'
          ? '#admin/voice'
          : '#admin';
      window.history.replaceState(null, '', `/${hash}`);
    } else if (nextView === 'feedback') {
      const search = requestedEventId
        ? `?view=feedback&event=${encodeURIComponent(requestedEventId)}`
        : '?view=feedback';
      window.history.replaceState(null, '', `/${search}`);
    } else {
      const search = requestedEventId
        ? `?event=${encodeURIComponent(requestedEventId)}`
        : '';
      window.history.replaceState(null, '', `/${search}`);
    }
  };

  const handleSelectEventId = (eventId: string | null) => {
    setRequestedEventId(eventId);
    setView('checkin');
    const nextUrl = eventId ? `/?event=${encodeURIComponent(eventId)}` : '/';
    window.history.replaceState(null, '', nextUrl);
  };

  const handleOpenFeedbackEvent = (eventId?: string | null) => {
    const targetId = eventId ?? null;
    setRequestedEventId(targetId);
    setView('feedback');
    const nextUrl = targetId
      ? `/?view=feedback&event=${encodeURIComponent(targetId)}`
      : '/?view=feedback';
    window.history.replaceState(null, '', nextUrl);
  };

  const orgName = branding?.organizationName?.trim() || '';
  const logoUrl = branding?.logoDataUrl || '';

  return (
    <ErrorBoundary>
      <DeviceAuthGate
        branding={branding}
        isDirectQrLink={isQrParticipantView}
        user={user}
        authReady={authReady}
      >
        <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                if (!isQrParticipantView) {
                  setRequestedEventId(null);
                }
                navigateToView(view === 'feedback' && isQrParticipantView ? 'feedback' : 'checkin');
              }}
              className="flex items-center gap-3 min-w-0 shrink-0"
            >
              {logoUrl && (
                <img
                  src={logoUrl}
                  alt={orgName ? `${orgName} logo` : 'Organization logo'}
                  className="h-9 w-9 sm:h-10 sm:w-10 rounded-lg object-contain bg-white border border-slate-200 p-0.5 shrink-0"
                />
              )}
              <div className="min-w-0 flex flex-col leading-tight">
                {orgName ? (
                  <>
                    <span className="font-display text-sm sm:text-base font-extrabold tracking-tight text-slate-900 truncate max-w-[180px] sm:max-w-[260px]">
                      {orgName}
                    </span>
                    <span className="text-[11px] font-bold tracking-wider text-blue-700 uppercase">
                      PRESENZA
                    </span>
                  </>
                ) : (
                  <span className="font-display text-base sm:text-lg font-extrabold tracking-tight text-slate-900 whitespace-nowrap">
                    PRESENZA
                  </span>
                )}
              </div>
            </a>

            {isQrParticipantView ? (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleSelectEventId(requestedEventId)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    view === 'checkin'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Check-In
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenFeedbackEvent(requestedEventId)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    view === 'feedback'
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Feedback &amp; Evaluation
                </button>
              </div>
            ) : (
              <>
                <nav
                  className="hidden md:flex items-center gap-5 text-sm font-medium"
                  aria-label="Primary navigation"
                >
                  <button
                    type="button"
                    onClick={() => navigateToView('checkin')}
                    className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                      view === 'checkin'
                        ? 'border-blue-700 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Participant Check-In
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateToView('feedback')}
                    className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                      view === 'feedback'
                        ? 'border-blue-700 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Feedback &amp; Evaluation
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateToView('admin', 'certificates')}
                    className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                      view === 'admin' && adminSection === 'certificates'
                        ? 'border-amber-600 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Certificates &amp; Recognition
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateToView('admin', 'attendance')}
                    className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                      view === 'admin' && adminSection !== 'certificates'
                        ? 'border-blue-700 text-slate-900 font-semibold'
                        : 'border-transparent text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Admin Console
                  </button>
                </nav>

                <div className="flex items-center shrink-0">
                  {view !== 'admin' ? (
                    <button
                      type="button"
                      onClick={() => navigateToView('admin', 'attendance')}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                    >
                      {user ? 'Admin Console' : 'Admin Sign In'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigateToView('checkin')}
                      className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-900 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                    >
                      Check-In Form
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Mobile Quick Nav Bar when not in QR lock */}
          {!isQrParticipantView && (
            <div className="md:hidden border-t border-slate-100 px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto bg-white">
              <button
                type="button"
                onClick={() => navigateToView('checkin')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${
                  view === 'checkin'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Check-In
              </button>
              <button
                type="button"
                onClick={() => navigateToView('feedback')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${
                  view === 'feedback'
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Feedback &amp; Evaluation
              </button>
              <button
                type="button"
                onClick={() => navigateToView('admin', 'certificates')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${
                  view === 'admin' && adminSection === 'certificates'
                    ? 'bg-amber-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Certificates &amp; Recognition
              </button>
            </div>
          )}
        </header>

        <main className="flex-1">
          {view === 'checkin' ? (
            <ParticipantCheckIn
              requestedEventId={requestedEventId}
              user={user}
              onSelectEventId={handleSelectEventId}
              onGoToFeedback={(eventId) => handleOpenFeedbackEvent(eventId)}
              onGoToAdmin={
                isQrParticipantView
                  ? undefined
                  : () => navigateToView('admin', 'attendance')
              }
            />
          ) : view === 'feedback' ? (
            <ParticipantFeedback
              requestedEventId={requestedEventId}
              user={user}
              onSelectEventId={(eventId) => handleOpenFeedbackEvent(eventId)}
              onGoToCheckIn={(eventId) =>
                handleSelectEventId(eventId ?? null)
              }
              onGoToAdmin={
                isQrParticipantView
                  ? undefined
                  : () => navigateToView('admin', 'feedback')
              }
            />
          ) : (
            <AdminConsole
              user={user}
              authReady={authReady}
              branding={branding}
              activeSection={adminSection}
              onChangeSection={(sec) => {
                setAdminSection(sec);
                const hash =
                  sec === 'live-board'
                    ? '#admin/live-board'
                    : sec === 'feedback'
                    ? '#admin/feedback'
                    : sec === 'certificates'
                    ? '#admin/certificates'
                    : sec === 'voice'
                    ? '#admin/voice'
                    : '#admin';
                window.history.replaceState(null, '', `/${hash}`);
              }}
              onOpenCheckIn={(eventId) => handleSelectEventId(eventId)}
              onOpenFeedbackForm={(eventId) => handleOpenFeedbackEvent(eventId)}
            />
          )}
        </main>

        <footer className="border-t border-slate-200 bg-white py-4 px-4 sm:px-6 lg:px-8">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              {orgName ? `${orgName} · ` : ''}PRESENZA · Workshops, Seminars &amp; Professional Development
            </span>
            <span>
              QR attendance check-in &amp; evaluation (participant login optional)
            </span>
          </div>
        </footer>
        </div>
      </DeviceAuthGate>
    </ErrorBoundary>
  );
}
