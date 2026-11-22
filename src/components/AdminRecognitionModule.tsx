import {
  Award,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare,
  Download,
  Edit3,
  Eye,
  FileCheck2,
  ImagePlus,
  Loader2,
  Palette,
  PenTool,
  Plus,
  Printer,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Square,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { type User } from 'firebase/auth';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  db,
  handleFirestoreError,
  normalizeAdminEmail,
} from '../firebase';
import {
  type AttendanceRecord,
  type CertificateSettings,
  type CertificateTermKey,
  type CertificateThemeId,
  type EventRecord,
  type FeedbackSubmissionRecord,
  type IssuedCertificateRecord,
  OperationType,
  type OrganizationBranding,
  type RecognitionCategory,
  type RecognitionFontFamily,
  type RecognitionTemplateConfig,
} from '../types';
import { formatLocalDateYmd, generateSafeId } from '../utils/dateTime';
import {
  buildCertificateDedupeKey,
  buildCertificateDocId,
  CERTIFICATE_TERM_OPTIONS,
  DEFAULT_RECOGNITION_CATEGORIES,
  DEFAULT_RECOGNITION_TEMPLATE,
  DEFAULT_TERM_BEST_CATEGORIES,
  generateCertificateNumber,
  interpolateRecognitionWording,
  mergeRecognitionTemplate,
  resolveBestTermLabel,
} from '../utils/feedbackAndRecognitionDefaults';
import {
  compressCertificateBackground,
  compressLogoFile,
  compressSignatureCanvas,
  compressSignatureFile,
} from '../utils/imageCompress';
import {
  CERTIFICATE_THEME_LIST,
  CERTIFICATE_THEMES,
  downloadRecognitionCertificatesPdf,
  mergeCertificateSettings,
  printRecognitionCertificatesPdf,
  type RecognitionPdfBatchOptions,
} from '../utils/pdfExport';

interface AdminRecognitionModuleProps {
  user: User;
  events: EventRecord[];
  attendances: AttendanceRecord[];
  feedbackSubmissions: FeedbackSubmissionRecord[];
  branding?: OrganizationBranding | null;
  categories: RecognitionCategory[];
  templateConfig: RecognitionTemplateConfig;
  certificates: IssuedCertificateRecord[];
  certificateSettings: CertificateSettings;
  onSyncCertificateSettings?: (next: CertificateSettings) => Promise<void>;
}

const STUDIO_COLOR_PRESETS: ReadonlyArray<{
  themeId: CertificateThemeId;
  name: string;
  primaryColor: string;
  accentColor: string;
  paperColor: string;
}> = CERTIFICATE_THEME_LIST.map((theme) => ({
  themeId: theme.id,
  name: theme.name,
  primaryColor: theme.outerBorderHex,
  accentColor: theme.innerBorderHex,
  paperColor: theme.paperHex,
}));

const PLACEHOLDER_TOKENS = [
  '{{participant}}',
  '{{category}}',
  '{{event}}',
  '{{date}}',
  '{{venue}}',
  '{{topic}}',
  '{{facilitator}}',
  '{{organizer}}',
];

function inferThemeIdFromColors(
  primaryColor: string,
  accentColor: string,
  fallback: CertificateThemeId = 'classic-navy'
): CertificateThemeId {
  const matched = STUDIO_COLOR_PRESETS.find(
    (p) =>
      p.primaryColor.toLowerCase() === primaryColor.toLowerCase() &&
      p.accentColor.toLowerCase() === accentColor.toLowerCase()
  );
  return matched ? matched.themeId : fallback;
}

interface RecognitionCertificateCanvasProps {
  template: RecognitionTemplateConfig;
  backgroundDataUrl?: string;
  backgroundOpacity?: number;
  logoUrl?: string;
  organizerName: string;
  ribbonText: string;
  recipientName: string;
  recipientDepartment?: string;
  wordingText: string;
  topicText?: string;
  themeText?: string;
  certificateNumber: string;
  issueDate: string;
  eventTitle: string;
}

function RecognitionCertificateCanvas({
  template,
  backgroundDataUrl,
  backgroundOpacity = 22,
  logoUrl,
  organizerName,
  ribbonText,
  recipientName,
  recipientDepartment,
  wordingText,
  topicText,
  themeText,
  certificateNumber,
  issueDate,
  eventTitle,
}: RecognitionCertificateCanvasProps) {
  const metaParts: string[] = [];
  if (template.showTopic && themeText?.trim()) {
    metaParts.push(`Theme: ${themeText.trim()}`);
  }
  if (template.showTopic && topicText?.trim()) {
    metaParts.push(`Topic: ${topicText.trim()}`);
  }

  return (
    <div
      className={`w-full shadow-lg rounded-sm relative overflow-hidden flex flex-col justify-between p-6 sm:p-8 text-center transition-all mx-auto ${
        template.orientation === 'portrait'
          ? 'max-w-[440px] aspect-[210/297]'
          : 'max-w-[680px] aspect-[297/210]'
      }`}
      style={{
        backgroundColor: template.paperColor,
        border: `4px solid ${template.primaryColor}`,
        fontFamily:
          template.fontFamily === 'times'
            ? 'Georgia, "Times New Roman", serif'
            : template.fontFamily === 'courier'
            ? 'ui-monospace, monospace'
            : 'system-ui, sans-serif',
      }}
    >
      {/* Background Photo with Controlled Opacity */}
      {backgroundDataUrl && backgroundOpacity > 0 && (
        <div className="absolute inset-2 overflow-hidden pointer-events-none">
          <img
            src={backgroundDataUrl}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover"
            style={{ opacity: Math.min(1, Math.max(0, backgroundOpacity / 100)) }}
          />
        </div>
      )}

      {/* Inner accent border */}
      <div
        className="absolute inset-2 pointer-events-none"
        style={{ border: `1.5px solid ${template.accentColor}` }}
      />

      <div className="relative z-10 flex flex-col items-center space-y-2 pt-1.5">
        {logoUrl && (
          <img
            src={logoUrl}
            alt="Organization logo"
            className="h-10 w-10 object-contain"
          />
        )}
        <div
          className="text-[10px] font-bold tracking-widest uppercase"
          style={{ color: template.accentColor }}
        >
          {organizerName}
        </div>
        <h4
          className="text-xl sm:text-2xl font-bold tracking-tight leading-tight"
          style={{ color: template.primaryColor }}
        >
          {template.title}
        </h4>
        {template.subtitle && (
          <p className="text-[10px] uppercase tracking-wider text-slate-500">
            {template.subtitle}
          </p>
        )}

        <div
          className="mt-1 px-4 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-slate-50/90 border"
          style={{
            color: template.accentColor,
            borderColor: template.accentColor,
          }}
        >
          {ribbonText}
        </div>
      </div>

      <div className="relative z-10 my-auto py-3 space-y-2">
        <p className="text-[11px] text-slate-500">
          This recognition award is proudly presented to
        </p>
        <div
          className="text-2xl sm:text-3xl font-bold"
          style={{ color: template.primaryColor }}
        >
          {recipientName}
        </div>
        {recipientDepartment?.trim() && (
          <div
            className="text-xs font-bold"
            style={{ color: template.accentColor }}
          >
            {recipientDepartment}
          </div>
        )}
        <div className="w-40 h-px bg-slate-300 mx-auto" />
        <p className="text-xs text-slate-700 leading-relaxed max-w-lg mx-auto">
          {wordingText}
        </p>
        {metaParts.length > 0 && (
          <div
            className="text-[11px] font-bold pt-1"
            style={{ color: template.primaryColor }}
          >
            {metaParts.join(' · ')}
          </div>
        )}
      </div>

      <div className="relative z-10 space-y-2.5 pb-1">
        <div className="grid grid-cols-2 gap-8 sm:gap-12 items-end text-[10px] max-w-lg mx-auto">
          <div className="flex flex-col items-center">
            {template.picPdSignatureDataUrl && (
              <img
                src={template.picPdSignatureDataUrl}
                alt="PIC of Professional Development signature"
                className="h-8 object-contain mb-1"
              />
            )}
            {template.picPdName.trim() && (
              <div
                className="font-bold pb-0.5 truncate max-w-full"
                style={{ color: template.primaryColor }}
              >
                {template.picPdName.trim()}
              </div>
            )}
            <div className="w-full border-t border-slate-300 pt-1 text-slate-600 font-medium truncate">
              {template.picPdTitle.trim() || 'PIC of Professional Development'}
            </div>
          </div>

          <div className="flex flex-col items-center">
            {template.principalSignatureDataUrl && (
              <img
                src={template.principalSignatureDataUrl}
                alt="Principal signature"
                className="h-8 object-contain mb-1"
              />
            )}
            {template.principalName.trim() && (
              <div
                className="font-bold pb-0.5 truncate max-w-full"
                style={{ color: template.primaryColor }}
              >
                {template.principalName.trim()}
              </div>
            )}
            <div className="w-full border-t border-slate-300 pt-1 text-slate-600 font-medium truncate">
              {template.principalTitle.trim() || 'Principal'}
            </div>
          </div>
        </div>

        {template.showCertificateId && (
          <div className="font-mono-tabular text-[9px] text-slate-500">
            Certificate ID: {certificateNumber} · Issued: {issueDate} · Event:{' '}
            {eventTitle}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminRecognitionModule({
  user,
  events,
  attendances,
  feedbackSubmissions,
  branding,
  categories,
  templateConfig,
  certificates,
  certificateSettings,
  onSyncCertificateSettings,
}: AdminRecognitionModuleProps) {
  // ONLY 2 top sub-menus:
  // 1. choose-event (Event picker + Award & Issue + Certificate Recognition Recap per event)
  // 2. studio (Certificate Studio: themes, background, Term 1–4, all categories, wording, signatories)
  const [subTab, setSubTab] = useState<'choose-event' | 'studio'>(
    'choose-event'
  );
  const [studioSection, setStudioSection] = useState<
    'theme' | 'categories' | 'signatories'
  >('theme');

  // Event & Category selection for awarding & recap
  const [selectedEventId, setSelectedEventId] = useState<string>(
    () => events[0]?.id || ''
  );
  const [selectionMode, setSelectionMode] = useState<'manual' | 'evaluation'>(
    'manual'
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    () => categories[0]?.id || ''
  );
  const [participantSearch, setParticipantSearch] = useState('');
  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState<Set<string>>(
    () => new Set()
  );

  // Manual nominee addition
  const [customNomineeName, setCustomNomineeName] = useState('');
  const [customNomineeDept, setCustomNomineeDept] = useState('');
  const [customNomineeEmail, setCustomNomineeEmail] = useState('');

  // Issue state
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);

  // Event Certificate Recognition Recap filter/selection & modal preview
  const [recapSearch, setRecapSearch] = useState('');
  const [recapCategoryFilter, setRecapCategoryFilter] = useState<string>('all');
  const [selectedCertIds, setSelectedCertIds] = useState<Set<string>>(
    () => new Set()
  );
  const [deletingCertId, setDeletingCertId] = useState<string | null>(null);
  const [previewCert, setPreviewCert] =
    useState<IssuedCertificateRecord | null>(null);

  // Categories CRUD state (inside Certificate Studio)
  const [seedingCategories, setSeedingCategories] = useState(false);
  const autoSeededRef = useRef(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [editingCat, setEditingCat] = useState<RecognitionCategory | null>(null);
  const [editCatName, setEditCatName] = useState('');
  const [editCatDesc, setEditCatDesc] = useState('');
  const [savingCat, setSavingCat] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);
  const [catSavedNote, setCatSavedNote] = useState<string | null>(null);

  // Certificate Studio Draft state (Template + Theme/Background sync)
  const [draftTemplate, setDraftTemplate] = useState<RecognitionTemplateConfig>(
    () => mergeRecognitionTemplate(templateConfig)
  );
  const [draftThemeId, setDraftThemeId] = useState<CertificateThemeId>(
    () =>
      certificateSettings?.themeId ||
      inferThemeIdFromColors(
        templateConfig.primaryColor,
        templateConfig.accentColor
      )
  );
  const [draftBgDataUrl, setDraftBgDataUrl] = useState<string>(
    () => certificateSettings?.backgroundDataUrl || ''
  );
  const [draftBgOpacity, setDraftBgOpacity] = useState<number>(
    () => certificateSettings?.backgroundOpacity ?? 22
  );
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const logoUploadRef = useRef<HTMLInputElement | null>(null);
  const bgUploadRef = useRef<HTMLInputElement | null>(null);
  const picPdSigUploadRef = useRef<HTMLInputElement | null>(null);
  const principalSigUploadRef = useRef<HTMLInputElement | null>(null);

  // Signature Draw Pad
  const [drawingRole, setDrawingRole] = useState<'picPd' | 'principal' | null>(
    null
  );
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);

  // Sync studio draft when remote updates
  useEffect(() => {
    setDraftTemplate(mergeRecognitionTemplate(templateConfig));
  }, [templateConfig]);

  useEffect(() => {
    setDraftThemeId(certificateSettings.themeId);
    setDraftBgDataUrl(certificateSettings.backgroundDataUrl || '');
    setDraftBgOpacity(certificateSettings.backgroundOpacity ?? 22);
  }, [certificateSettings]);

  // Keep selectedEventId & selectedCategoryId valid
  useEffect(() => {
    if (events.length > 0 && !events.some((e) => e.id === selectedEventId)) {
      setSelectedEventId(events[0].id);
    }
  }, [events, selectedEventId]);

  useEffect(() => {
    if (
      categories.length > 0 &&
      !categories.some((c) => c.id === selectedCategoryId)
    ) {
      setSelectedCategoryId(categories[0].id);
    }
  }, [categories, selectedCategoryId]);

  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );

  const eventsById = useMemo(
    () => new Map(events.map((e) => [e.id, e])),
    [events]
  );

  const pdfBatchOptions: RecognitionPdfBatchOptions = useMemo(
    () => ({
      certificateSettings,
      categoriesById,
      eventsById,
    }),
    [certificateSettings, categoriesById, eventsById]
  );

  // Seed default 14 recognition categories once automatically if empty
  const seedDefaultCategories = async () => {
    if (seedingCategories) return;
    setSeedingCategories(true);
    setCatError(null);
    try {
      const batch = writeBatch(db);
      for (const cat of DEFAULT_RECOGNITION_CATEGORIES) {
        if (!categories.some((existing) => existing.id === cat.id)) {
          batch.set(doc(db, 'recognitionCategories', cat.id), {
            name: cat.name,
            description: cat.description,
            sortOrder: cat.sortOrder,
            createdByUid: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
      setCatSavedNote('Default & Term 1–4 recognition categories restored.');
      window.setTimeout(() => setCatSavedNote(null), 2600);
    } catch (error) {
      setCatError('Unable to restore default recognition categories.');
      handleFirestoreError(
        error,
        OperationType.WRITE,
        'recognitionCategories'
      );
    } finally {
      setSeedingCategories(false);
    }
  };

  useEffect(() => {
    if (categories.length === 0 && !autoSeededRef.current) {
      autoSeededRef.current = true;
      void seedDefaultCategories();
    }
  }, [categories.length]);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

  const selectedCategory = useMemo(
    () => categories.find((c) => c.id === selectedCategoryId) ?? null,
    [categories, selectedCategoryId]
  );

  // Attendance records & linked evaluation insights for selectedEvent
  const eventParticipants = useMemo(() => {
    if (!selectedEvent) return [];
    const recs = attendances.filter((a) => a.eventId === selectedEvent.id);
    const eventSubs = feedbackSubmissions.filter(
      (f) => f.eventId === selectedEvent.id
    );

    const q = participantSearch.trim().toLowerCase();

    return recs
      .map((rec, index) => {
        const matchedFeedback = eventSubs.find((sub) => {
          if (sub.attendanceId && sub.attendanceId === rec.id) return true;
          if (
            sub.participantEmail &&
            rec.participantEmail &&
            sub.participantEmail.toLowerCase() ===
              rec.participantEmail.toLowerCase()
          ) {
            return true;
          }
          if (
            sub.participantName &&
            sub.participantName.trim().toLowerCase() ===
              rec.fullName.trim().toLowerCase()
          ) {
            return true;
          }
          return false;
        });

        const dedupeKey = selectedCategory
          ? buildCertificateDedupeKey(
              selectedEvent.id,
              selectedCategory.id,
              rec.fullName,
              rec.participantEmail
            )
          : '';
        const alreadyIssued = dedupeKey
          ? certificates.some((c) => c.dedupeKey === dedupeKey)
          : false;

        return {
          record: rec,
          arrivalRank: index + 1,
          matchedFeedback,
          alreadyIssued,
        };
      })
      .filter((item) => {
        if (!q) return true;
        const hay = `${item.record.fullName} ${item.record.classDepartment} ${
          item.record.participantEmail || ''
        }`.toLowerCase();
        return hay.includes(q);
      });
  }, [
    selectedEvent,
    attendances,
    feedbackSubmissions,
    participantSearch,
    selectedCategory,
    certificates,
  ]);

  // Certificates scoped to the currently chosen event — dynamically aligned with live categories & studio settings
  const eventCertificates = useMemo(() => {
    if (!selectedEvent) return [];
    return certificates.filter((c) => c.eventId === selectedEvent.id);
  }, [certificates, selectedEvent]);

  const activeStudioTermLabel = useMemo(
    () =>
      resolveBestTermLabel(
        templateConfig.bestTerm,
        templateConfig.termBestCategories
      ),
    [templateConfig.bestTerm, templateConfig.termBestCategories]
  );

  // Per-category counts inside the selected event's Certificate Recognition Recap
  const eventRecapCategoryBreakdown = useMemo(() => {
    const counts = new Map<string, { categoryId: string; name: string; count: number }>();
    for (const cert of eventCertificates) {
      const liveCatName =
        categoriesById.get(cert.categoryId)?.name?.trim() || cert.categoryName;
      const existing = counts.get(cert.categoryId);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(cert.categoryId, {
          categoryId: cert.categoryId,
          name: liveCatName,
          count: 1,
        });
      }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [eventCertificates, categoriesById]);

  const filteredEventRecapCertificates = useMemo(() => {
    const q = recapSearch.trim().toLowerCase();
    return eventCertificates.filter((cert) => {
      if (
        recapCategoryFilter !== 'all' &&
        cert.categoryId !== recapCategoryFilter
      ) {
        return false;
      }
      if (q) {
        const liveCatName =
          categoriesById.get(cert.categoryId)?.name?.trim() || cert.categoryName;
        const hay =
          `${cert.participantName} ${cert.participantDepartment} ${liveCatName} ${cert.certificateNumber}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [eventCertificates, recapCategoryFilter, recapSearch, categoriesById]);

  const selectedRecapBulkCerts = useMemo(() => {
    if (selectedCertIds.size === 0) return filteredEventRecapCertificates;
    return filteredEventRecapCertificates.filter((c) =>
      selectedCertIds.has(c.id)
    );
  }, [filteredEventRecapCertificates, selectedCertIds]);

  const toggleAttendanceSelection = (id: string) => {
    setSelectedAttendanceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Issue single or bulk certificates for selected attendance participants
  const handleIssueSelectedCertificates = async () => {
    if (!selectedEvent || !selectedCategory) return;
    setIssueError(null);
    setIssueSuccess(null);

    const chosen = eventParticipants.filter((item) =>
      selectedAttendanceIds.has(item.record.id)
    );
    if (chosen.length === 0) {
      setIssueError('Select at least one participant checkbox first.');
      return;
    }

    const toCreate = chosen.filter((item) => !item.alreadyIssued);
    if (toCreate.length === 0) {
      setIssueError(
        `All selected participants already received "${selectedCategory.name}" for this event.`
      );
      return;
    }

    setIssuing(true);
    const todayYmd = formatLocalDateYmd(new Date());
    const eventDateVal = /^\d{4}-\d{2}-\d{2}$/.test(selectedEvent.eventDate)
      ? selectedEvent.eventDate
      : todayYmd;
    const organizerName = (
      branding?.organizationName?.trim() || 'PRESENZA'
    ).slice(0, 120);
    const eventTopicVal = (
      selectedEvent.topic?.trim() ||
      selectedEvent.category ||
      ''
    ).slice(0, 200);
    const eventThemeVal = (selectedEvent.theme?.trim() || '').slice(0, 120);
    const facilitatorsVal = (selectedEvent.facilitators?.trim() || '').slice(
      0,
      200
    );
    const issuerEmail = normalizeAdminEmail(user.email || '');

    const activeTermCategory = resolveBestTermLabel(
      templateConfig.bestTerm,
      templateConfig.termBestCategories
    ).slice(0, 100);
    const picPdNameVal = templateConfig.picPdName.trim().slice(0, 120);
    const picPdTitleVal = (
      templateConfig.picPdTitle.trim() || 'PIC of Professional Development'
    ).slice(0, 120);
    const principalNameVal = templateConfig.principalName.trim().slice(0, 120);
    const principalTitleVal = (
      templateConfig.principalTitle.trim() || 'Principal'
    ).slice(0, 120);

    let createdCount = 0;
    try {
      const CHUNK = 400;
      for (let i = 0; i < toCreate.length; i += CHUNK) {
        const slice = toCreate.slice(i, i + CHUNK);
        const batch = writeBatch(db);
        for (const item of slice) {
          const rec = item.record;
          const dedupeKey = buildCertificateDedupeKey(
            selectedEvent.id,
            selectedCategory.id,
            rec.fullName,
            rec.participantEmail
          );
          const certDocId = buildCertificateDocId(dedupeKey);
          const certNumber = generateCertificateNumber();
          const wording = interpolateRecognitionWording(
            templateConfig.wordingTemplate,
            {
              participant: rec.fullName,
              category: selectedCategory.name,
              event: selectedEvent.title,
              date: eventDateVal,
              venue: selectedEvent.venue,
              topic: eventTopicVal,
              theme: eventThemeVal,
              facilitator: picPdNameVal || facilitatorsVal,
              organizer: organizerName,
              department: rec.classDepartment,
            }
          ).slice(0, 700);

          batch.set(doc(db, 'certificates', certDocId), {
            certificateNumber: certNumber,
            dedupeKey,
            eventId: selectedEvent.id,
            eventTitle: selectedEvent.title.slice(0, 140),
            eventDate: eventDateVal,
            eventVenue: (selectedEvent.venue || '').slice(0, 120),
            eventTheme: eventThemeVal,
            eventTopic: eventTopicVal,
            facilitators: facilitatorsVal,
            organizerName,
            attendanceId: rec.id,
            participantName: rec.fullName.slice(0, 100),
            participantDepartment: rec.classDepartment.slice(0, 100),
            participantEmail: rec.participantEmail
              ? normalizeAdminEmail(rec.participantEmail).slice(0, 128)
              : '',
            categoryId: selectedCategory.id,
            categoryName: selectedCategory.name.slice(0, 100),
            bestTerm: templateConfig.bestTerm,
            termCategoryName: activeTermCategory,
            issueDate: todayYmd,
            selectionMethod: selectionMode,
            orientation: templateConfig.orientation,
            certificateTitle: templateConfig.title.slice(0, 120),
            certificateSubtitle: templateConfig.subtitle.slice(0, 140),
            wordingText: wording,
            fontFamily: templateConfig.fontFamily,
            primaryColor: templateConfig.primaryColor,
            accentColor: templateConfig.accentColor,
            paperColor: templateConfig.paperColor,
            signatoryLabel: picPdTitleVal,
            picPdName: picPdNameVal,
            picPdTitle: picPdTitleVal,
            principalName: principalNameVal,
            principalTitle: principalTitleVal,
            issuedByUid: user.uid,
            issuedByEmail: issuerEmail,
            createdAt: serverTimestamp(),
          });
          createdCount += 1;
        }
        await batch.commit();
      }

      setSelectedAttendanceIds(new Set());
      const skipped = chosen.length - createdCount;
      setIssueSuccess(
        `Issued ${createdCount} certificate${createdCount === 1 ? '' : 's'} for "${selectedCategory.name}"${
          skipped > 0 ? ` (${skipped} duplicate skipped)` : ''
        }.`
      );
    } catch (error) {
      setIssueError(
        'Could not issue one or more certificates. Duplicate awards for the same participant, event, and category are blocked.'
      );
      handleFirestoreError(error, OperationType.WRITE, 'certificates');
    } finally {
      setIssuing(false);
    }
  };

  // Issue single manual certificate for someone not in attendance table
  const handleIssueCustomNominee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEvent || !selectedCategory) return;
    setIssueError(null);
    setIssueSuccess(null);

    const name = customNomineeName.trim().slice(0, 100);
    const dept = customNomineeDept.trim().slice(0, 100);
    const email = customNomineeEmail.trim().toLowerCase().slice(0, 128);
    if (name.length < 2) {
      setIssueError('Enter at least 2 characters for the recipient name.');
      return;
    }

    const dedupeKey = buildCertificateDedupeKey(
      selectedEvent.id,
      selectedCategory.id,
      name,
      email
    );
    if (certificates.some((c) => c.dedupeKey === dedupeKey)) {
      setIssueError(
        `${name} already received "${selectedCategory.name}" for this event.`
      );
      return;
    }

    setIssuing(true);
    const todayYmd = formatLocalDateYmd(new Date());
    const eventDateVal = /^\d{4}-\d{2}-\d{2}$/.test(selectedEvent.eventDate)
      ? selectedEvent.eventDate
      : todayYmd;
    const organizerName = (
      branding?.organizationName?.trim() || 'PRESENZA'
    ).slice(0, 120);
    const eventTopicVal = (
      selectedEvent.topic?.trim() ||
      selectedEvent.category ||
      ''
    ).slice(0, 200);
    const eventThemeVal = (selectedEvent.theme?.trim() || '').slice(0, 120);
    const facilitatorsVal = (selectedEvent.facilitators?.trim() || '').slice(
      0,
      200
    );
    const certDocId = buildCertificateDocId(dedupeKey);
    const certNumber = generateCertificateNumber();

    const activeTermCategory = resolveBestTermLabel(
      templateConfig.bestTerm,
      templateConfig.termBestCategories
    ).slice(0, 100);
    const picPdNameVal = templateConfig.picPdName.trim().slice(0, 120);
    const picPdTitleVal = (
      templateConfig.picPdTitle.trim() || 'PIC of Professional Development'
    ).slice(0, 120);
    const principalNameVal = templateConfig.principalName.trim().slice(0, 120);
    const principalTitleVal = (
      templateConfig.principalTitle.trim() || 'Principal'
    ).slice(0, 120);

    const wording = interpolateRecognitionWording(
      templateConfig.wordingTemplate,
      {
        participant: name,
        category: selectedCategory.name,
        event: selectedEvent.title,
        date: eventDateVal,
        venue: selectedEvent.venue,
        topic: eventTopicVal,
        theme: eventThemeVal,
        facilitator: picPdNameVal || facilitatorsVal,
        organizer: organizerName,
        department: dept,
      }
    ).slice(0, 700);

    try {
      await setDoc(doc(db, 'certificates', certDocId), {
        certificateNumber: certNumber,
        dedupeKey,
        eventId: selectedEvent.id,
        eventTitle: selectedEvent.title.slice(0, 140),
        eventDate: eventDateVal,
        eventVenue: (selectedEvent.venue || '').slice(0, 120),
        eventTheme: eventThemeVal,
        eventTopic: eventTopicVal,
        facilitators: facilitatorsVal,
        organizerName,
        attendanceId: '',
        participantName: name,
        participantDepartment: dept,
        participantEmail: email,
        categoryId: selectedCategory.id,
        categoryName: selectedCategory.name.slice(0, 100),
        bestTerm: templateConfig.bestTerm,
        termCategoryName: activeTermCategory,
        issueDate: todayYmd,
        selectionMethod: 'manual',
        orientation: templateConfig.orientation,
        certificateTitle: templateConfig.title.slice(0, 120),
        certificateSubtitle: templateConfig.subtitle.slice(0, 140),
        wordingText: wording,
        fontFamily: templateConfig.fontFamily,
        primaryColor: templateConfig.primaryColor,
        accentColor: templateConfig.accentColor,
        paperColor: templateConfig.paperColor,
        signatoryLabel: picPdTitleVal,
        picPdName: picPdNameVal,
        picPdTitle: picPdTitleVal,
        principalName: principalNameVal,
        principalTitle: principalTitleVal,
        issuedByUid: user.uid,
        issuedByEmail: normalizeAdminEmail(user.email || ''),
        createdAt: serverTimestamp(),
      });

      setCustomNomineeName('');
      setCustomNomineeDept('');
      setCustomNomineeEmail('');
      setIssueSuccess(
        `Issued certificate ${certNumber} to ${name} (${selectedCategory.name}).`
      );
    } catch (error) {
      setIssueError('Failed to issue certificate. Please check all fields.');
      handleFirestoreError(
        error,
        OperationType.CREATE,
        `certificates/${certDocId}`
      );
    } finally {
      setIssuing(false);
    }
  };

  // Recognition Categories CRUD (in Certificate Studio)
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatError(null);
    setCatSavedNote(null);
    const name = newCatName.trim().slice(0, 100);
    const desc = newCatDesc.trim().slice(0, 300);
    if (name.length < 2) {
      setCatError('Category name must be at least 2 characters.');
      return;
    }

    setSavingCat(true);
    const catId = generateSafeId('rec');
    try {
      await setDoc(doc(db, 'recognitionCategories', catId), {
        name,
        description: desc,
        sortOrder: categories.length + 1,
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewCatName('');
      setNewCatDesc('');
      setCatSavedNote(`Added "${name}" — synced to all events.`);
      window.setTimeout(() => setCatSavedNote(null), 2600);
    } catch (error) {
      setCatError('Unable to add recognition category.');
      handleFirestoreError(
        error,
        OperationType.CREATE,
        `recognitionCategories/${catId}`
      );
    } finally {
      setSavingCat(false);
    }
  };

  const handleSaveEditCategory = async () => {
    if (!editingCat) return;
    setCatError(null);
    setCatSavedNote(null);
    const name = editCatName.trim().slice(0, 100);
    const desc = editCatDesc.trim().slice(0, 300);
    if (name.length < 2) {
      setCatError('Category name must be at least 2 characters.');
      return;
    }
    setSavingCat(true);
    try {
      await updateDoc(doc(db, 'recognitionCategories', editingCat.id), {
        name,
        description: desc,
        sortOrder: editingCat.sortOrder,
        updatedAt: serverTimestamp(),
      });
      setEditingCat(null);
      setCatSavedNote(`Updated "${name}" — aligned across all event recaps.`);
      window.setTimeout(() => setCatSavedNote(null), 2600);
    } catch (error) {
      setCatError('Unable to update category.');
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `recognitionCategories/${editingCat.id}`
      );
    } finally {
      setSavingCat(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    setCatError(null);
    setCatSavedNote(null);
    try {
      await deleteDoc(doc(db, 'recognitionCategories', id));
      setCatSavedNote('Category removed.');
      window.setTimeout(() => setCatSavedNote(null), 2200);
    } catch (error) {
      setCatError('Unable to delete category.');
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `recognitionCategories/${id}`
      );
    }
  };

  // Certificate Studio Save & Sync across recognitionTemplates/default AND certificateSettings/default
  const handleSaveTemplate = async () => {
    setTemplateError(null);
    setTemplateSaved(false);
    const clean = mergeRecognitionTemplate(draftTemplate);
    if (clean.title.trim().length < 2) {
      setTemplateError('Certificate title must be at least 2 characters.');
      return;
    }
    if (clean.wordingTemplate.trim().length < 5) {
      setTemplateError('Wording template must be at least 5 characters.');
      return;
    }

    setSavingTemplate(true);
    try {
      await setDoc(doc(db, 'recognitionTemplates', 'default'), {
        ...clean,
        signatureDataUrl: '',
        signatoryLabel: clean.picPdTitle || 'PIC of Professional Development',
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });

      if (onSyncCertificateSettings) {
        const syncedCertSettings = mergeCertificateSettings({
          ...certificateSettings,
          themeId: draftThemeId,
          backgroundDataUrl: draftBgDataUrl,
          backgroundOpacity: draftBgOpacity,
          bestTerm: clean.bestTerm,
          termBestCategories: clean.termBestCategories,
          picPdName: clean.picPdName,
          picPdTitle: clean.picPdTitle,
          principalName: clean.principalName,
          principalTitle: clean.principalTitle,
          facilitatorSignatureDataUrl: clean.picPdSignatureDataUrl,
          principalSignatureDataUrl: clean.principalSignatureDataUrl,
        });
        await onSyncCertificateSettings(syncedCertSettings);
      }

      setTemplateSaved(true);
      window.setTimeout(() => setTemplateSaved(false), 3000);
    } catch (error) {
      setTemplateError('Unable to save Certificate Studio settings.');
      handleFirestoreError(
        error,
        OperationType.WRITE,
        'recognitionTemplates/default'
      );
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleUploadCustomLogo = async (file: File) => {
    setTemplateError(null);
    try {
      const dataUrl = await compressLogoFile(file);
      setDraftTemplate((prev) => ({ ...prev, customLogoDataUrl: dataUrl }));
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : 'Failed to process logo file.'
      );
    }
  };

  const handleUploadBgPhoto = async (file: File) => {
    setTemplateError(null);
    try {
      const dataUrl = await compressCertificateBackground(file);
      setDraftBgDataUrl(dataUrl);
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : 'Failed to process background photo.'
      );
    }
  };

  const handleUploadSignature = async (
    role: 'picPd' | 'principal',
    file: File
  ) => {
    setTemplateError(null);
    try {
      const dataUrl = await compressSignatureFile(file);
      setDraftTemplate((prev) => ({
        ...prev,
        ...(role === 'picPd'
          ? { picPdSignatureDataUrl: dataUrl, signatureDataUrl: '' }
          : { principalSignatureDataUrl: dataUrl }),
      }));
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : 'Failed to process signature file.'
      );
    }
  };

  // Canvas signature drawing handlers
  const handleStartDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    isDrawingRef.current = true;
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(
      ((e.clientX - rect.left) / rect.width) * canvas.width,
      ((e.clientY - rect.top) / rect.height) * canvas.height
    );
  };

  const handleMoveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(
      ((e.clientX - rect.left) / rect.width) * canvas.width,
      ((e.clientY - rect.top) / rect.height) * canvas.height
    );
    ctx.stroke();
  };

  const handleEndDraw = () => {
    isDrawingRef.current = false;
  };

  const handleClearDrawCanvas = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const handleApplyDrawnSignature = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas || !drawingRole) return;
    setTemplateError(null);
    try {
      const dataUrl = compressSignatureCanvas(canvas);
      setDraftTemplate((prev) => ({
        ...prev,
        ...(drawingRole === 'picPd'
          ? { picPdSignatureDataUrl: dataUrl, signatureDataUrl: '' }
          : { principalSignatureDataUrl: dataUrl }),
      }));
      setDrawingRole(null);
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : 'Please draw a signature first.'
      );
    }
  };

  const toggleRecapCertSelect = (id: string) => {
    setSelectedCertIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteCertificate = async (id: string) => {
    setDeletingCertId(id);
    try {
      await deleteDoc(doc(db, 'certificates', id));
      setSelectedCertIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (previewCert?.id === id) {
        setPreviewCert(null);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `certificates/${id}`);
    } finally {
      setDeletingCertId(null);
    }
  };

  // Studio Live Preview strings
  const previewBestTermLabel = useMemo(
    () =>
      resolveBestTermLabel(
        draftTemplate.bestTerm,
        draftTemplate.termBestCategories
      ),
    [draftTemplate.bestTerm, draftTemplate.termBestCategories]
  );

  const previewRibbonText = useMemo(() => {
    const baseCategory = selectedCategory?.name || 'Best Participant';
    if (!previewBestTermLabel) return baseCategory;
    if (previewBestTermLabel.toLowerCase() === baseCategory.toLowerCase()) {
      return previewBestTermLabel;
    }
    return `${previewBestTermLabel} · ${baseCategory}`;
  }, [previewBestTermLabel, selectedCategory?.name]);

  const previewSampleWording = useMemo(() => {
    const ev = selectedEvent ?? events[0];
    return interpolateRecognitionWording(draftTemplate.wordingTemplate, {
      participant: eventParticipants[0]?.record.fullName || 'Dr. Sarah Jenkins',
      category: selectedCategory?.name || 'Best Participant',
      event: ev?.title || 'Teacher Professional Development Workshop',
      date: ev?.eventDate || formatLocalDateYmd(new Date()),
      venue: ev?.venue || 'Main Conference Hall',
      topic: ev?.topic || ev?.category || 'Instructional Excellence',
      theme: ev?.theme || '',
      facilitator:
        draftTemplate.picPdName.trim() || ev?.facilitators || 'Ms. Elena Vance',
      organizer: branding?.organizationName || 'PRESENZA Academy',
      department:
        eventParticipants[0]?.record.classDepartment || 'Curriculum Team',
    });
  }, [
    draftTemplate.wordingTemplate,
    draftTemplate.picPdName,
    selectedEvent,
    events,
    eventParticipants,
    selectedCategory,
    branding,
  ]);

  const previewLogoUrl =
    draftTemplate.customLogoDataUrl || branding?.logoDataUrl || '';

  return (
    <div className="space-y-6">
      {/* Module Header & 2 Sub-Menus: Choose Event & Certificate Studio */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900">
            Certificates &amp; Recognition
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Select an event to award participants and review its synchronized certificate recap, or customize themes, categories, Term 1–4 distinctions, and signatures in Certificate Studio.
          </p>
        </div>

        <div
          className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1 gap-1 self-start lg:self-auto shrink-0"
          role="tablist"
          aria-label="Certificate and recognition sub-menus"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'choose-event'}
            onClick={() => setSubTab('choose-event')}
            className={`min-h-[40px] px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              subTab === 'choose-event'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CalendarDays className="w-4 h-4 text-amber-700" />
            <span>1. Choose Event</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'studio'}
            onClick={() => setSubTab('studio')}
            className={`min-h-[40px] px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              subTab === 'studio'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Palette className="w-4 h-4 text-amber-700" />
            <span>2. Certificate Studio</span>
          </button>
        </div>
      </div>

      {/* SUB-MENU 1: CHOOSE EVENT (Award & Issue + Event Certificate Recognition Recap) */}
      {subTab === 'choose-event' && (
        <div className="space-y-6">
          {/* A. Event Selector & Recognition Category */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-6">
                <label
                  htmlFor="rec-event-select"
                  className="block text-xs font-bold uppercase tracking-wider text-blue-700 mb-1.5"
                >
                  Choose Event
                </label>
                <select
                  id="rec-event-select"
                  value={selectedEventId}
                  onChange={(e) => {
                    setSelectedEventId(e.target.value);
                    setSelectedAttendanceIds(new Set());
                    setSelectedCertIds(new Set());
                    setRecapCategoryFilter('all');
                    setRecapSearch('');
                    setIssueError(null);
                    setIssueSuccess(null);
                  }}
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-semibold bg-slate-50 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {events.length === 0 && (
                    <option value="">No events created yet</option>
                  )}
                  {events.map((ev) => {
                    const count = certificates.filter(
                      (c) => c.eventId === ev.id
                    ).length;
                    return (
                      <option key={ev.id} value={ev.id}>
                        {ev.title} ({ev.eventDate}) · {count} cert
                        {count === 1 ? '' : 's'}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="lg:col-span-6">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label
                    htmlFor="rec-category-select"
                    className="block text-xs font-bold uppercase tracking-wider text-amber-700"
                  >
                    Recognition Category
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setSubTab('studio');
                      setStudioSection('categories');
                    }}
                    className="text-[11px] font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0"
                  >
                    Customize Categories in Studio
                  </button>
                </div>
                <select
                  id="rec-category-select"
                  value={selectedCategoryId}
                  onChange={(e) => {
                    setSelectedCategoryId(e.target.value);
                    setIssueError(null);
                    setIssueSuccess(null);
                  }}
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-semibold bg-slate-50 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedEvent && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 text-xs">
                <div>
                  <div className="text-slate-500 font-medium">Event Date</div>
                  <div className="font-mono-tabular font-bold text-slate-900 mt-0.5">
                    {selectedEvent.eventDate}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">Location</div>
                  <div className="font-bold text-slate-900 truncate mt-0.5">
                    {selectedEvent.venue}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">Theme</div>
                  <div className="font-bold text-slate-900 truncate mt-0.5">
                    {selectedEvent.theme?.trim() || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">Topic</div>
                  <div className="font-bold text-slate-900 truncate mt-0.5">
                    {selectedEvent.topic?.trim() || selectedEvent.category}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">Facilitators</div>
                  <div className="font-bold text-slate-900 truncate mt-0.5">
                    {selectedEvent.facilitators?.trim() || 'Session Facilitator'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">Organizer</div>
                  <div className="font-bold text-slate-900 truncate mt-0.5">
                    {branding?.organizationName?.trim() || 'PRESENZA'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">Checked In</div>
                  <div className="font-mono-tabular font-bold text-slate-900 mt-0.5">
                    {
                      attendances.filter((a) => a.eventId === selectedEvent.id)
                        .length
                    }
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 font-medium">
                    Certificates Issued
                  </div>
                  <div className="font-mono-tabular font-bold text-amber-700 mt-0.5">
                    {eventCertificates.length}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* B. Participant Selection & Issuing */}
          {selectedEvent ? (
            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="text-base font-bold text-slate-900">
                      Select Recipients for Award
                    </h3>
                    <div
                      className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                      role="group"
                      aria-label="Participant selection method"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectionMode('manual')}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          selectionMode === 'manual'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Manual Selection
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectionMode('evaluation')}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          selectionMode === 'evaluation'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Evaluation-Based Review
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {selectionMode === 'evaluation'
                      ? 'Review check-in timeliness, arrival rank, and participant evaluation comments before issuing awards.'
                      : 'Search checked-in attendees and select participants to award recognition certificates.'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="relative min-w-[200px]">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={participantSearch}
                      onChange={(e) => setParticipantSearch(e.target.value)}
                      placeholder="Search attendance list..."
                      className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={issuing || selectedAttendanceIds.size === 0}
                    onClick={() => void handleIssueSelectedCertificates()}
                    className="min-h-[40px] px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {issuing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileCheck2 className="w-4 h-4" />
                    )}
                    <span>
                      Issue Selected ({selectedAttendanceIds.size})
                    </span>
                  </button>
                </div>
              </div>

              {issueError && (
                <div className="mx-6 mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 font-medium">
                  {issueError}
                </div>
              )}

              {issueSuccess && (
                <div className="mx-6 mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 font-semibold flex flex-wrap items-center justify-between gap-2">
                  <span>{issueSuccess}</span>
                  <button
                    type="button"
                    onClick={() => {
                      document
                        .getElementById('event-certificate-recap')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className="underline font-bold hover:text-emerald-950 shrink-0"
                  >
                    Jump to Event Recap
                  </button>
                </div>
              )}

              {eventParticipants.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                  <Users className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-semibold text-slate-900">
                    No attendance records found for this event
                  </p>
                  <p className="text-xs text-slate-500">
                    Participants appear here once they check in, or you can manually enter a nominee below.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4 w-10">Select</th>
                        <th className="py-3 px-4">Arrival</th>
                        <th className="py-3 px-4">Participant</th>
                        <th className="py-3 px-4">Class / Dept</th>
                        <th className="py-3 px-4">Check-In &amp; Status</th>
                        {selectionMode === 'evaluation' && (
                          <th className="py-3 px-4">
                            Linked Feedback &amp; Evaluation Notes
                          </th>
                        )}
                        <th className="py-3 px-4 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {eventParticipants.map(
                        ({
                          record,
                          arrivalRank,
                          matchedFeedback,
                          alreadyIssued,
                        }) => {
                          const checked = selectedAttendanceIds.has(record.id);
                          return (
                            <tr
                              key={record.id}
                              onClick={() => {
                                if (!alreadyIssued) {
                                  toggleAttendanceSelection(record.id);
                                }
                              }}
                              className={`transition-colors ${
                                alreadyIssued
                                  ? 'bg-slate-50/60 opacity-75'
                                  : checked
                                  ? 'bg-amber-50/50 cursor-pointer'
                                  : 'hover:bg-slate-50 cursor-pointer'
                              }`}
                            >
                              <td
                                className="py-3 px-4"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  disabled={alreadyIssued}
                                  onClick={() =>
                                    toggleAttendanceSelection(record.id)
                                  }
                                  aria-label={`Select ${record.fullName}`}
                                  className="text-slate-500 hover:text-amber-700 disabled:opacity-40"
                                >
                                  {checked ? (
                                    <CheckSquare className="w-4 h-4 text-amber-700" />
                                  ) : (
                                    <Square className="w-4 h-4" />
                                  )}
                                </button>
                              </td>
                              <td className="py-3 px-4 font-mono-tabular text-xs font-bold text-slate-600">
                                #{arrivalRank}
                              </td>
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5">
                                  <img
                                    src={record.photoDataUrl}
                                    alt={record.fullName}
                                    className="w-8 h-8 rounded-full object-cover border border-slate-200 shrink-0"
                                  />
                                  <div className="min-w-0">
                                    <div className="font-semibold text-slate-900 truncate">
                                      {record.fullName}
                                    </div>
                                    {record.participantEmail && (
                                      <div className="text-[11px] text-slate-500 truncate">
                                        {record.participantEmail}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="py-3 px-4 text-xs text-slate-700">
                                {record.classDepartment}
                              </td>
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2 text-xs">
                                  <span
                                    className={`font-semibold ${
                                      record.status === 'On Time'
                                        ? 'text-emerald-700'
                                        : 'text-amber-700'
                                    }`}
                                  >
                                    {record.status}
                                  </span>
                                  <span aria-hidden="true" className="text-slate-300">
                                    ·
                                  </span>
                                  <span className="font-mono-tabular text-slate-500">
                                    {record.checkInTime}
                                  </span>
                                </div>
                              </td>
                              {selectionMode === 'evaluation' && (
                                <td className="py-3 px-4 text-xs">
                                  {matchedFeedback ? (
                                    <div className="space-y-0.5">
                                      <div className="inline-flex items-center gap-1 font-semibold text-amber-700">
                                        <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-500" />
                                        <span className="font-mono-tabular">
                                          {matchedFeedback.averageRating.toFixed(1)} ★ feedback
                                        </span>
                                      </div>
                                      {matchedFeedback.writtenComment && (
                                        <div className="text-[11px] text-slate-600 line-clamp-1 max-w-xs">
                                          &ldquo;{matchedFeedback.writtenComment}&rdquo;
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 italic">
                                      No linked feedback comment
                                    </span>
                                  )}
                                </td>
                              )}
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                {alreadyIssued ? (
                                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    <span>Issued</span>
                                  </span>
                                ) : (
                                  <span className="text-xs text-slate-400">
                                    Eligible
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        }
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Add & Issue Manual Nominee outside attendance roster */}
              <form
                onSubmit={handleIssueCustomNominee}
                className="px-6 py-4 bg-slate-50 border-t border-slate-200 space-y-3"
              >
                <div className="text-xs font-bold uppercase tracking-wider text-slate-700 inline-flex items-center gap-1.5">
                  <UserPlus className="w-3.5 h-3.5 text-blue-700" />
                  <span>
                    Or Issue Directly to a Manual Nominee (
                    {selectedCategory?.name || 'Category'})
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={customNomineeName}
                    onChange={(e) => setCustomNomineeName(e.target.value)}
                    placeholder="Recipient full name *"
                    className="min-h-[40px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <input
                    type="text"
                    maxLength={100}
                    value={customNomineeDept}
                    onChange={(e) => setCustomNomineeDept(e.target.value)}
                    placeholder="Class / Department (optional)"
                    className="min-h-[40px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <input
                    type="email"
                    maxLength={128}
                    value={customNomineeEmail}
                    onChange={(e) => setCustomNomineeEmail(e.target.value)}
                    placeholder="Email (optional)"
                    className="min-h-[40px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <button
                    type="submit"
                    disabled={issuing || !selectedCategory}
                    className="min-h-[40px] px-4 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Award className="w-3.5 h-3.5" />
                    <span>Issue Single Certificate</span>
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <section className="bg-white border border-slate-200 rounded-2xl p-10 text-center space-y-2">
              <CalendarDays className="w-9 h-9 text-slate-300 mx-auto" />
              <p className="text-sm font-semibold text-slate-900">
                No Events Created Yet
              </p>
              <p className="text-xs text-slate-500">
                Create an event session from the Admin Console first to award and review recognition certificates here.
              </p>
            </section>
          )}

          {/* C. CERTIFICATE RECOGNITION RECAP FOR THIS CHOSEN EVENT */}
          {selectedEvent && (
            <section
              id="event-certificate-recap"
              className="bg-white border border-slate-200 rounded-2xl overflow-hidden"
            >
              <div className="p-5 sm:p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-slate-900">
                    Certificate Recognition Recap — {selectedEvent.title}
                  </h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono-tabular">
                      {eventCertificates.length} certificate
                      {eventCertificates.length === 1 ? '' : 's'} issued
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Aligned with Studio ({templateConfig.orientation} ·{' '}
                      {CERTIFICATE_THEMES[certificateSettings.themeId]?.name ||
                        'Custom Theme'}
                      {activeStudioTermLabel ? ` · ${activeStudioTermLabel}` : ''}
                      )
                    </span>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={() => setSubTab('studio')}
                      className="text-blue-700 font-semibold hover:underline"
                    >
                      Edit in Certificate Studio
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={selectedRecapBulkCerts.length === 0}
                    onClick={() =>
                      downloadRecognitionCertificatesPdf(
                        selectedRecapBulkCerts,
                        templateConfig,
                        branding,
                        `${selectedEvent.title}-recap`,
                        pdfBatchOptions
                      )
                    }
                    className="min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>
                      {selectedCertIds.size > 0
                        ? `Download Selected (${selectedCertIds.size}) PDF`
                        : `Download Event Recap (${filteredEventRecapCertificates.length}) PDF`}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={selectedRecapBulkCerts.length === 0}
                    onClick={() =>
                      printRecognitionCertificatesPdf(
                        selectedRecapBulkCerts,
                        templateConfig,
                        branding,
                        pdfBatchOptions
                      )
                    }
                    className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Print</span>
                  </button>
                </div>
              </div>

              {/* Event Category Breakdown & Search Filter */}
              <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 space-y-3">
                {eventRecapCategoryBreakdown.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRecapCategoryFilter('all')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        recapCategoryFilter === 'all'
                          ? 'bg-slate-900 text-white'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      All Categories ({eventCertificates.length})
                    </button>
                    {eventRecapCategoryBreakdown.map((item) => (
                      <button
                        key={item.categoryId}
                        type="button"
                        onClick={() => setRecapCategoryFilter(item.categoryId)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          recapCategoryFilter === item.categoryId
                            ? 'bg-amber-600 text-white'
                            : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {item.name} ({item.count})
                      </button>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={recapSearch}
                      onChange={(e) => setRecapSearch(e.target.value)}
                      placeholder="Search recipient, category, or Certificate ID..."
                      className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl"
                    />
                  </div>

                  <select
                    value={recapCategoryFilter}
                    onChange={(e) => setRecapCategoryFilter(e.target.value)}
                    aria-label="Filter event recap by category"
                    className="min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl text-slate-800"
                  >
                    <option value="all">
                      All Recognition Categories ({eventCertificates.length})
                    </option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {filteredEventRecapCertificates.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <Award className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-semibold text-slate-900">
                    {eventCertificates.length === 0
                      ? `No certificates issued yet for "${selectedEvent.title}"`
                      : 'No certificates match the current filter'}
                  </p>
                  <p className="text-xs text-slate-500">
                    Select recipients above to issue certificates — every award automatically stays synchronized with Certificate Studio.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4 w-10">Pick</th>
                        <th className="py-3 px-4">Certificate ID</th>
                        <th className="py-3 px-4">Recipient</th>
                        <th className="py-3 px-4">Synced Category &amp; Term</th>
                        <th className="py-3 px-4">Method</th>
                        <th className="py-3 px-4">Issued Date</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredEventRecapCertificates.map((cert) => {
                        const picked = selectedCertIds.has(cert.id);
                        const liveCatName =
                          categoriesById.get(cert.categoryId)?.name?.trim() ||
                          cert.categoryName;
                        const liveTermLabel = activeStudioTermLabel;
                        return (
                          <tr key={cert.id} className="hover:bg-slate-50/70">
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                onClick={() => toggleRecapCertSelect(cert.id)}
                                aria-label={`Select certificate ${cert.certificateNumber}`}
                                className="text-slate-500 hover:text-blue-700"
                              >
                                {picked ? (
                                  <CheckSquare className="w-4 h-4 text-blue-700" />
                                ) : (
                                  <Square className="w-4 h-4" />
                                )}
                              </button>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-xs font-bold text-slate-800 whitespace-nowrap">
                              {cert.certificateNumber}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">
                                {cert.participantName}
                              </div>
                              {cert.participantDepartment && (
                                <div className="text-xs text-slate-500">
                                  {cert.participantDepartment}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              <div className="text-xs font-bold text-amber-800">
                                {liveCatName}
                              </div>
                              {liveTermLabel &&
                                liveTermLabel.toLowerCase() !==
                                  liveCatName.toLowerCase() && (
                                  <div className="text-[11px] font-medium text-slate-500 mt-0.5">
                                    {liveTermLabel}
                                  </div>
                                )}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-600 capitalize whitespace-nowrap">
                              {cert.selectionMethod === 'evaluation'
                                ? 'Evaluation Review'
                                : 'Manual'}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-xs text-slate-600 whitespace-nowrap">
                              {cert.issueDate}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setPreviewCert(cert)}
                                  className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 inline-flex items-center gap-1"
                                >
                                  <Eye className="w-3.5 h-3.5 text-blue-700" />
                                  <span>Preview</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    downloadRecognitionCertificatesPdf(
                                      [cert],
                                      templateConfig,
                                      branding,
                                      undefined,
                                      pdfBatchOptions
                                    )
                                  }
                                  className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 inline-flex items-center gap-1"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>PDF</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    printRecognitionCertificatesPdf(
                                      [cert],
                                      templateConfig,
                                      branding,
                                      pdfBatchOptions
                                    )
                                  }
                                  className="min-h-[34px] min-w-[34px] rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 inline-flex items-center justify-center"
                                  aria-label={`Print certificate ${cert.certificateNumber}`}
                                >
                                  <Printer className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={deletingCertId === cert.id}
                                  onClick={() => void handleDeleteCertificate(cert.id)}
                                  className="min-h-[34px] min-w-[34px] rounded-lg border border-slate-200 text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center disabled:opacity-40"
                                  aria-label={`Revoke certificate ${cert.certificateNumber}`}
                                >
                                  {deletingCertId === cert.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* SUB-MENU 2: CERTIFICATE STUDIO (Unified Theme, Categories, Term 1–4, Wording & Signatories) */}
      {subTab === 'studio' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Controls Column */}
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Certificate Studio
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  All edits synchronize with every event&rsquo;s certificate recap and PDF exports.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDraftTemplate({ ...DEFAULT_RECOGNITION_TEMPLATE });
                  setDraftThemeId('classic-navy');
                  setDraftBgDataUrl('');
                  setDraftBgOpacity(22);
                }}
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>

            {/* Studio Internal Section Switcher */}
            <div
              className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-xl"
              role="group"
              aria-label="Certificate studio sections"
            >
              {(
                [
                  { id: 'theme', label: 'Theme & Layout' },
                  { id: 'categories', label: `Categories (${categories.length})` },
                  { id: 'signatories', label: 'Text & Signatories' },
                ] as const
              ).map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => setStudioSection(sec.id)}
                  className={`min-h-[36px] px-2 py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap ${
                    studioSection === sec.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {sec.label}
                </button>
              ))}
            </div>

            {/* STUDIO SECTION A: THEME, BACKGROUND PHOTO & LAYOUT */}
            {studioSection === 'theme' && (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-700 mb-1.5">
                      Page Orientation
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-xl">
                      {(['landscape', 'portrait'] as const).map((orient) => (
                        <button
                          key={orient}
                          type="button"
                          onClick={() =>
                            setDraftTemplate((prev) => ({
                              ...prev,
                              orientation: orient,
                            }))
                          }
                          className={`min-h-[34px] rounded-lg text-xs font-semibold capitalize transition-colors ${
                            draftTemplate.orientation === orient
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {orient}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="rec-font-select"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Typography Font
                    </label>
                    <select
                      id="rec-font-select"
                      value={draftTemplate.fontFamily}
                      onChange={(e) =>
                        setDraftTemplate((prev) => ({
                          ...prev,
                          fontFamily: e.target.value as RecognitionFontFamily,
                        }))
                      }
                      className="w-full min-h-[40px] px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl font-semibold text-slate-900"
                    >
                      <option value="times">Classic Serif (Times)</option>
                      <option value="helvetica">Clean Sans (Helvetica)</option>
                      <option value="courier">Archival Mono (Courier)</option>
                    </select>
                  </div>
                </div>

                {/* Theme Presets & Hex Colors */}
                <div className="space-y-2.5">
                  <div className="text-xs font-semibold text-slate-700">
                    Certificate Theme Presets &amp; Custom Colors
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {STUDIO_COLOR_PRESETS.map((preset) => {
                      const active =
                        draftThemeId === preset.themeId &&
                        draftTemplate.primaryColor.toLowerCase() ===
                          preset.primaryColor.toLowerCase();
                      return (
                        <button
                          key={preset.themeId}
                          type="button"
                          onClick={() => {
                            setDraftThemeId(preset.themeId);
                            setDraftTemplate((prev) => ({
                              ...prev,
                              primaryColor: preset.primaryColor,
                              accentColor: preset.accentColor,
                              paperColor: preset.paperColor,
                            }));
                          }}
                          className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors ${
                            active
                              ? 'border-blue-600 bg-blue-50 text-blue-900'
                              : 'border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700'
                          }`}
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full border border-slate-300 shrink-0"
                            style={{ backgroundColor: preset.primaryColor }}
                          />
                          <span>{preset.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <label className="text-[11px] text-slate-600 font-medium space-y-1">
                      <span>Primary</span>
                      <input
                        type="color"
                        value={draftTemplate.primaryColor}
                        onChange={(e) =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            primaryColor: e.target.value,
                          }))
                        }
                        className="w-full h-9 rounded-lg border border-slate-300 cursor-pointer"
                      />
                    </label>
                    <label className="text-[11px] text-slate-600 font-medium space-y-1">
                      <span>Accent</span>
                      <input
                        type="color"
                        value={draftTemplate.accentColor}
                        onChange={(e) =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            accentColor: e.target.value,
                          }))
                        }
                        className="w-full h-9 rounded-lg border border-slate-300 cursor-pointer"
                      />
                    </label>
                    <label className="text-[11px] text-slate-600 font-medium space-y-1">
                      <span>Paper</span>
                      <input
                        type="color"
                        value={draftTemplate.paperColor}
                        onChange={(e) =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            paperColor: e.target.value,
                          }))
                        }
                        className="w-full h-9 rounded-lg border border-slate-300 cursor-pointer"
                      />
                    </label>
                  </div>
                </div>

                {/* Certificate Background Photo & Transparency */}
                <div className="pt-3 border-t border-slate-200 space-y-3">
                  <input
                    ref={bgUploadRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleUploadBgPhoto(file);
                    }}
                    className="hidden"
                    aria-label="Upload certificate background photo"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">
                        Background Photo / Watermark
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Synced across live certificate preview and event PDF downloads.
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => bgUploadRef.current?.click()}
                        className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1"
                      >
                        <ImagePlus className="w-3.5 h-3.5 text-blue-700" />
                        <span>{draftBgDataUrl ? 'Change Photo' : 'Upload Photo'}</span>
                      </button>
                      {draftBgDataUrl && (
                        <button
                          type="button"
                          onClick={() => setDraftBgDataUrl('')}
                          className="min-h-[34px] px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-700"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>

                  {draftBgDataUrl && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] text-slate-600 font-medium">
                        <span>Background Opacity</span>
                        <span className="font-mono-tabular font-bold">
                          {draftBgOpacity}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={85}
                        value={draftBgOpacity}
                        onChange={(e) => setDraftBgOpacity(Number(e.target.value))}
                        className="w-full accent-blue-700"
                      />
                    </div>
                  )}
                </div>

                {/* Visibility Toggles */}
                <div className="pt-3 border-t border-slate-200 flex flex-wrap gap-4 text-xs font-medium text-slate-700">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draftTemplate.showTopic}
                      onChange={(e) =>
                        setDraftTemplate((prev) => ({
                          ...prev,
                          showTopic: e.target.checked,
                        }))
                      }
                    />
                    <span>Show Topic / Theme</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draftTemplate.showCertificateId}
                      onChange={(e) =>
                        setDraftTemplate((prev) => ({
                          ...prev,
                          showCertificateId: e.target.checked,
                        }))
                      }
                    />
                    <span>Show Certificate ID</span>
                  </label>
                </div>
              </div>
            )}

            {/* STUDIO SECTION B: ALL RECOGNITION CATEGORIES & TERM 1–4 */}
            {studioSection === 'categories' && (
              <div className="space-y-5">
                {/* Best Category for Term 1 – Term 4 */}
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-bold text-slate-900">
                      Best Category by Term (Term 1 – Term 4)
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Activate a term distinction ribbon and customize each term&rsquo;s title. Saving aligns this across all events.
                    </p>
                  </div>

                  <div
                    className="grid grid-cols-5 gap-1 p-1 bg-slate-100 rounded-xl"
                    role="group"
                    aria-label="Best category term selector"
                  >
                    {CERTIFICATE_TERM_OPTIONS.map((opt) => {
                      const active = draftTemplate.bestTerm === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() =>
                            setDraftTemplate((prev) => ({
                              ...prev,
                              bestTerm: opt.key as CertificateTermKey,
                            }))
                          }
                          className={`min-h-[34px] px-1.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                            active
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {opt.shortLabel}
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {(['term1', 'term2', 'term3', 'term4'] as const).map(
                      (tKey, idx) => (
                        <div key={tKey}>
                          <label
                            htmlFor={`rec-term-${tKey}`}
                            className="block text-[11px] font-semibold text-slate-700 mb-1"
                          >
                            Term {idx + 1} Title
                          </label>
                          <input
                            id={`rec-term-${tKey}`}
                            type="text"
                            maxLength={100}
                            value={draftTemplate.termBestCategories[tKey]}
                            placeholder={DEFAULT_TERM_BEST_CATEGORIES[tKey]}
                            onChange={(e) =>
                              setDraftTemplate((prev) => ({
                                ...prev,
                                termBestCategories: {
                                  ...prev.termBestCategories,
                                  [tKey]: e.target.value,
                                },
                              }))
                            }
                            className="w-full min-h-[36px] px-2.5 py-1 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                          />
                        </div>
                      )
                    )}
                  </div>
                </div>

                {/* All Recognition Categories Customization */}
                <div className="pt-4 border-t border-slate-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-bold text-slate-900">
                        All Recognition Categories ({categories.length})
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Add, rename, or delete categories. Renamed categories update automatically in every event&rsquo;s recap.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={seedingCategories}
                      onClick={() => void seedDefaultCategories()}
                      className="min-h-[32px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold text-slate-800 inline-flex items-center gap-1"
                    >
                      {seedingCategories ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Sparkles className="w-3 h-3 text-amber-600" />
                      )}
                      <span>Restore Defaults</span>
                    </button>
                  </div>

                  <form
                    onSubmit={handleAddCategory}
                    className="space-y-2 p-3 rounded-xl border border-slate-200 bg-slate-50"
                  >
                    <input
                      type="text"
                      required
                      maxLength={100}
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      placeholder="New category name (e.g. Best Presenter)..."
                      className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        maxLength={300}
                        value={newCatDesc}
                        onChange={(e) => setNewCatDesc(e.target.value)}
                        placeholder="Short criteria description (optional)"
                        className="flex-1 min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                      <button
                        type="submit"
                        disabled={savingCat}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add</span>
                      </button>
                    </div>
                  </form>

                  {catError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                      {catError}
                    </div>
                  )}
                  {catSavedNote && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 font-medium">
                      {catSavedNote}
                    </div>
                  )}

                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl">
                    {categories.map((cat) => (
                      <div
                        key={cat.id}
                        className="p-3 bg-white hover:bg-slate-50/70 space-y-2"
                      >
                        {editingCat?.id === cat.id ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              maxLength={100}
                              value={editCatName}
                              onChange={(e) => setEditCatName(e.target.value)}
                              className="w-full min-h-[34px] px-2.5 py-1 text-xs border border-slate-300 rounded-lg font-semibold"
                            />
                            <input
                              type="text"
                              maxLength={300}
                              value={editCatDesc}
                              onChange={(e) => setEditCatDesc(e.target.value)}
                              className="w-full min-h-[34px] px-2.5 py-1 text-xs border border-slate-300 rounded-lg"
                            />
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setEditingCat(null)}
                                className="min-h-[30px] px-2.5 py-1 rounded-md border border-slate-300 text-xs font-semibold text-slate-700"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={savingCat}
                                onClick={() => void handleSaveEditCategory()}
                                className="min-h-[30px] px-3 py-1 rounded-md bg-emerald-700 text-white text-xs font-semibold"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-slate-900">
                                {cat.name}
                              </div>
                              {cat.description && (
                                <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                                  {cat.description}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCat(cat);
                                  setEditCatName(cat.name);
                                  setEditCatDesc(cat.description);
                                }}
                                className="min-h-[30px] px-2 py-1 rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-[11px] font-semibold text-slate-700 inline-flex items-center gap-1"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>Edit</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteCategory(cat.id)}
                                className="min-h-[30px] min-w-[30px] rounded-md border border-slate-200 text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center"
                                aria-label={`Delete ${cat.name}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* STUDIO SECTION C: WORDING, LOGO & BOTTOM SIGNATORIES */}
            {studioSection === 'signatories' && (
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="rec-title-input"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Certificate Title
                  </label>
                  <input
                    id="rec-title-input"
                    type="text"
                    maxLength={120}
                    value={draftTemplate.title}
                    onChange={(e) =>
                      setDraftTemplate((prev) => ({
                        ...prev,
                        title: e.target.value,
                      }))
                    }
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label
                    htmlFor="rec-subtitle-input"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Subtitle
                  </label>
                  <input
                    id="rec-subtitle-input"
                    type="text"
                    maxLength={140}
                    value={draftTemplate.subtitle}
                    onChange={(e) =>
                      setDraftTemplate((prev) => ({
                        ...prev,
                        subtitle: e.target.value,
                      }))
                    }
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label
                    htmlFor="rec-wording-input"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Wording Template
                  </label>
                  <textarea
                    id="rec-wording-input"
                    rows={3}
                    maxLength={600}
                    value={draftTemplate.wordingTemplate}
                    onChange={(e) =>
                      setDraftTemplate((prev) => ({
                        ...prev,
                        wordingTemplate: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {PLACEHOLDER_TOKENS.map((tok) => (
                      <button
                        key={tok}
                        type="button"
                        onClick={() =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            wordingTemplate: `${prev.wordingTemplate} ${tok}`.slice(
                              0,
                              600
                            ),
                          }))
                        }
                        className="text-[10px] font-mono-tabular px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
                      >
                        +{tok}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Institution Logo & Bottom Signatories */}
                <div className="pt-3 border-t border-slate-200 space-y-4">
                  <input
                    ref={logoUploadRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleUploadCustomLogo(file);
                    }}
                    className="hidden"
                  />
                  <input
                    ref={picPdSigUploadRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleUploadSignature('picPd', file);
                    }}
                    className="hidden"
                    aria-label="Upload PIC of Professional Development signature"
                  />
                  <input
                    ref={principalSigUploadRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleUploadSignature('principal', file);
                    }}
                    className="hidden"
                    aria-label="Upload Principal signature"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700">
                      Institution Logo
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => logoUploadRef.current?.click()}
                        className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1"
                      >
                        <ImagePlus className="w-3.5 h-3.5 text-blue-700" />
                        <span>
                          {draftTemplate.customLogoDataUrl
                            ? 'Change Logo'
                            : 'Upload Custom Logo'}
                        </span>
                      </button>
                      {draftTemplate.customLogoDataUrl && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraftTemplate((prev) => ({
                              ...prev,
                              customLogoDataUrl: '',
                            }))
                          }
                          className="min-h-[34px] px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-700"
                        >
                          Use Default
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-slate-900">
                      Bottom Signatories (Native Template)
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Customize names, role titles, and signatures for PIC of Professional Development and Principal.
                    </p>
                  </div>

                  {(
                    [
                      {
                        role: 'picPd' as const,
                        heading: '1. PIC of Professional Development',
                        nameValue: draftTemplate.picPdName,
                        namePlaceholder: 'e.g., Ms. Elena Vance, M.Ed.',
                        titleValue: draftTemplate.picPdTitle,
                        defaultTitle: 'PIC of Professional Development',
                        signatureUrl: draftTemplate.picPdSignatureDataUrl,
                        uploadRef: picPdSigUploadRef,
                        onNameChange: (val: string) =>
                          setDraftTemplate((prev) => ({ ...prev, picPdName: val })),
                        onTitleChange: (val: string) =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            picPdTitle: val,
                            signatoryLabel: val,
                          })),
                        onClearSig: () =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            picPdSignatureDataUrl: '',
                            signatureDataUrl: '',
                          })),
                      },
                      {
                        role: 'principal' as const,
                        heading: '2. Principal',
                        nameValue: draftTemplate.principalName,
                        namePlaceholder: 'e.g., Dr. Ahmad Fauzi',
                        titleValue: draftTemplate.principalTitle,
                        defaultTitle: 'Principal',
                        signatureUrl: draftTemplate.principalSignatureDataUrl,
                        uploadRef: principalSigUploadRef,
                        onNameChange: (val: string) =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            principalName: val,
                          })),
                        onTitleChange: (val: string) =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            principalTitle: val,
                          })),
                        onClearSig: () =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            principalSignatureDataUrl: '',
                          })),
                      },
                    ] as const
                  ).map((sig) => (
                    <div
                      key={sig.role}
                      className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800">
                          {sig.heading}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => sig.uploadRef.current?.click()}
                            className="min-h-[32px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-[11px] font-semibold text-slate-700 inline-flex items-center gap-1"
                          >
                            <ImagePlus className="w-3.5 h-3.5 text-blue-700" />
                            <span>Upload</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDrawingRole((prev) =>
                                prev === sig.role ? null : sig.role
                              );
                              window.setTimeout(() => handleClearDrawCanvas(), 0);
                            }}
                            className="min-h-[32px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-[11px] font-semibold text-slate-700 inline-flex items-center gap-1"
                          >
                            <PenTool className="w-3.5 h-3.5 text-blue-700" />
                            <span>Draw</span>
                          </button>
                          {sig.signatureUrl && (
                            <button
                              type="button"
                              onClick={sig.onClearSig}
                              className="min-h-[32px] px-2 py-1 rounded-lg border border-rose-200 bg-rose-50 text-[11px] font-semibold text-rose-700"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      </div>

                      {sig.signatureUrl && (
                        <div className="h-14 rounded-lg border border-dashed border-slate-300 bg-white flex items-center justify-center p-1.5 overflow-hidden">
                          <img
                            src={sig.signatureUrl}
                            alt={`${sig.heading} signature preview`}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      )}

                      {drawingRole === sig.role && (
                        <div className="rounded-lg border border-blue-200 bg-white p-2.5 space-y-2">
                          <canvas
                            ref={drawCanvasRef}
                            width={360}
                            height={110}
                            onPointerDown={handleStartDraw}
                            onPointerMove={handleMoveDraw}
                            onPointerUp={handleEndDraw}
                            onPointerLeave={handleEndDraw}
                            className="w-full h-24 bg-slate-50 border border-slate-300 rounded-md touch-none cursor-crosshair"
                          />
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => setDrawingRole(null)}
                              className="text-[11px] font-semibold text-slate-500 hover:text-slate-900"
                            >
                              Cancel
                            </button>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={handleClearDrawCanvas}
                                className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-[11px] font-semibold text-slate-700"
                              >
                                Clear Pad
                              </button>
                              <button
                                type="button"
                                onClick={handleApplyDrawnSignature}
                                className="px-3 py-1 rounded-md bg-blue-700 text-white text-[11px] font-semibold"
                              >
                                Use Signature
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label
                            htmlFor={`rec-sig-name-${sig.role}`}
                            className="block text-[11px] font-semibold text-slate-600 mb-0.5"
                          >
                            Custom Name
                          </label>
                          <input
                            id={`rec-sig-name-${sig.role}`}
                            type="text"
                            maxLength={120}
                            value={sig.nameValue}
                            onChange={(e) => sig.onNameChange(e.target.value)}
                            placeholder={sig.namePlaceholder}
                            className="w-full min-h-[36px] px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`rec-sig-title-${sig.role}`}
                            className="block text-[11px] font-semibold text-slate-600 mb-0.5"
                          >
                            Role Title
                          </label>
                          <input
                            id={`rec-sig-title-${sig.role}`}
                            type="text"
                            maxLength={120}
                            value={sig.titleValue}
                            onChange={(e) => sig.onTitleChange(e.target.value)}
                            placeholder={sig.defaultTitle}
                            className="w-full min-h-[36px] px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-lg"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {templateError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800">
                {templateError}
              </div>
            )}

            {templateSaved && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 font-medium">
                Saved and synchronized with all event certificate recaps and PDF exports.
              </div>
            )}

            <button
              type="button"
              disabled={savingTemplate}
              onClick={() => void handleSaveTemplate()}
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {savingTemplate ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : templateSaved ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              <span>
                {templateSaved
                  ? 'Studio Saved & Synced!'
                  : 'Save & Sync Certificate Studio'}
              </span>
            </button>
          </section>

          {/* Live Synchronized Certificate Preview Column */}
          <section className="lg:col-span-7 bg-slate-100 border border-slate-200 rounded-2xl p-4 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <span className="font-bold uppercase tracking-wider">
                Live Certificate Preview ({draftTemplate.orientation})
              </span>
              <span className="font-mono-tabular">
                A4{' '}
                {draftTemplate.orientation === 'portrait'
                  ? '210 × 297 mm'
                  : '297 × 210 mm'}
              </span>
            </div>

            {/* Preview Event & Category Switcher so admin verifies alignment per event */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-white/80 p-3 rounded-xl border border-slate-200">
              <div>
                <label
                  htmlFor="studio-preview-event"
                  className="block text-[11px] font-semibold text-slate-600 mb-1"
                >
                  Preview Event Context
                </label>
                <select
                  id="studio-preview-event"
                  value={selectedEventId}
                  onChange={(e) => setSelectedEventId(e.target.value)}
                  className="w-full min-h-[36px] px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-lg font-medium text-slate-900"
                >
                  {events.length === 0 && (
                    <option value="">Sample Workshop Event</option>
                  )}
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="studio-preview-category"
                  className="block text-[11px] font-semibold text-slate-600 mb-1"
                >
                  Preview Recognition Category
                </label>
                <select
                  id="studio-preview-category"
                  value={selectedCategoryId}
                  onChange={(e) => setSelectedCategoryId(e.target.value)}
                  className="w-full min-h-[36px] px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-lg font-medium text-slate-900"
                >
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <RecognitionCertificateCanvas
              template={draftTemplate}
              backgroundDataUrl={draftBgDataUrl}
              backgroundOpacity={draftBgOpacity}
              logoUrl={previewLogoUrl}
              organizerName={branding?.organizationName?.trim() || 'PRESENZA'}
              ribbonText={previewRibbonText}
              recipientName={
                eventParticipants[0]?.record.fullName || 'Dr. Sarah Jenkins'
              }
              recipientDepartment={
                eventParticipants[0]?.record.classDepartment ||
                'Curriculum Department'
              }
              wordingText={previewSampleWording}
              topicText={
                selectedEvent?.topic?.trim() ||
                selectedEvent?.category ||
                'Instructional Excellence'
              }
              themeText={selectedEvent?.theme?.trim() || ''}
              certificateNumber="PRZ-2026-SAMPLE"
              issueDate={formatLocalDateYmd(new Date())}
              eventTitle={selectedEvent?.title || 'Workshop Session'}
            />
          </section>
        </div>
      )}

      {/* Live-Synced Issued Certificate Preview Modal */}
      {previewCert && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recap-cert-preview-title"
          onClick={() => setPreviewCert(null)}
        >
          <div
            className="w-full max-w-4xl max-h-[92vh] rounded-2xl bg-slate-100 border border-slate-200 shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 bg-white border-b border-slate-200 shrink-0">
              <div className="min-w-0">
                <h3
                  id="recap-cert-preview-title"
                  className="text-sm sm:text-base font-bold text-slate-900 truncate"
                >
                  {previewCert.participantName} —{' '}
                  {categoriesById.get(previewCert.categoryId)?.name ||
                    previewCert.categoryName}
                </h3>
                <p className="text-xs text-slate-500 font-mono-tabular">
                  {previewCert.certificateNumber} · Synced with Certificate Studio
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    downloadRecognitionCertificatesPdf(
                      [previewCert],
                      templateConfig,
                      branding,
                      undefined,
                      pdfBatchOptions
                    )
                  }
                  className="min-h-[36px] px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    printRecognitionCertificatesPdf(
                      [previewCert],
                      templateConfig,
                      branding,
                      pdfBatchOptions
                    )
                  }
                  className="min-h-[36px] px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewCert(null)}
                  className="min-h-[36px] min-w-[36px] rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 inline-flex items-center justify-center"
                  aria-label="Close certificate preview"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-5 sm:p-8 overflow-y-auto">
              {(() => {
                const liveEvent = eventsById.get(previewCert.eventId);
                const liveCategoryName =
                  categoriesById.get(previewCert.categoryId)?.name?.trim() ||
                  previewCert.categoryName;
                const ribbon =
                  activeStudioTermLabel &&
                  activeStudioTermLabel.toLowerCase() !==
                    liveCategoryName.toLowerCase()
                    ? `${activeStudioTermLabel} · ${liveCategoryName}`
                    : liveCategoryName;
                const resolvedOrganizer =
                  branding?.organizationName?.trim() ||
                  previewCert.organizerName ||
                  'PRESENZA';
                const resolvedEventTitle =
                  liveEvent?.title?.trim() || previewCert.eventTitle;
                const resolvedEventDate =
                  liveEvent?.eventDate?.trim() || previewCert.eventDate;
                const resolvedEventVenue =
                  liveEvent?.venue?.trim() || previewCert.eventVenue;
                const resolvedEventTopic =
                  liveEvent?.topic?.trim() ||
                  liveEvent?.category?.trim() ||
                  previewCert.eventTopic;
                const resolvedEventTheme =
                  liveEvent?.theme?.trim() || previewCert.eventTheme;
                const resolvedWording = interpolateRecognitionWording(
                  templateConfig.wordingTemplate,
                  {
                    participant: previewCert.participantName,
                    category: liveCategoryName,
                    event: resolvedEventTitle,
                    date: resolvedEventDate,
                    venue: resolvedEventVenue,
                    topic: resolvedEventTopic,
                    theme: resolvedEventTheme,
                    facilitator:
                      templateConfig.picPdName.trim() ||
                      liveEvent?.facilitators ||
                      previewCert.facilitators,
                    organizer: resolvedOrganizer,
                    department: previewCert.participantDepartment,
                  }
                );

                return (
                  <RecognitionCertificateCanvas
                    template={templateConfig}
                    backgroundDataUrl={certificateSettings.backgroundDataUrl}
                    backgroundOpacity={certificateSettings.backgroundOpacity}
                    logoUrl={
                      templateConfig.customLogoDataUrl ||
                      branding?.logoDataUrl ||
                      ''
                    }
                    organizerName={resolvedOrganizer}
                    ribbonText={ribbon}
                    recipientName={previewCert.participantName}
                    recipientDepartment={previewCert.participantDepartment}
                    wordingText={resolvedWording}
                    topicText={resolvedEventTopic}
                    themeText={resolvedEventTheme}
                    certificateNumber={previewCert.certificateNumber}
                    issueDate={previewCert.issueDate}
                    eventTitle={resolvedEventTitle}
                  />
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
