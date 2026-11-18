import {
  Award,
  Check,
  CheckCircle2,
  CheckSquare,
  Download,
  Edit3,
  FileCheck2,
  History,
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
  Tag,
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
  DEFAULT_RECOGNITION_CATEGORIES,
  DEFAULT_RECOGNITION_TEMPLATE,
  generateCertificateNumber,
  interpolateRecognitionWording,
  mergeRecognitionTemplate,
} from '../utils/feedbackAndRecognitionDefaults';
import {
  compressLogoFile,
  compressSignatureCanvas,
  compressSignatureFile,
} from '../utils/imageCompress';
import {
  downloadRecognitionCertificatesPdf,
  printRecognitionCertificatesPdf,
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
}

const COLOR_PRESETS: ReadonlyArray<{
  name: string;
  primaryColor: string;
  accentColor: string;
  paperColor: string;
}> = [
  {
    name: 'Classic Navy & Gold',
    primaryColor: '#0F172A',
    accentColor: '#B45309',
    paperColor: '#FFFFFF',
  },
  {
    name: 'Emerald Academic',
    primaryColor: '#065F46',
    accentColor: '#B45309',
    paperColor: '#FCFDFB',
  },
  {
    name: 'Royal Indigo',
    primaryColor: '#1E293B',
    accentColor: '#4F46E5',
    paperColor: '#FFFFFF',
  },
  {
    name: 'Crimson Crest',
    primaryColor: '#881337',
    accentColor: '#CA8A04',
    paperColor: '#FFFDF9',
  },
  {
    name: 'Teal Modern',
    primaryColor: '#0F766E',
    accentColor: '#0284C7',
    paperColor: '#FFFFFF',
  },
];

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

export default function AdminRecognitionModule({
  user,
  events,
  attendances,
  feedbackSubmissions,
  branding,
  categories,
  templateConfig,
  certificates,
}: AdminRecognitionModuleProps) {
  const [subTab, setSubTab] = useState<
    'issue' | 'designer' | 'categories' | 'history'
  >('issue');

  // Event & Category selection for awarding
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

  // Manual nominee addition (when recipient isn't in attendance log)
  const [customNomineeName, setCustomNomineeName] = useState('');
  const [customNomineeDept, setCustomNomineeDept] = useState('');
  const [customNomineeEmail, setCustomNomineeEmail] = useState('');

  // Issue state
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);

  // Categories CRUD state
  const [seedingCategories, setSeedingCategories] = useState(false);
  const autoSeededRef = useRef(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [editingCat, setEditingCat] = useState<RecognitionCategory | null>(null);
  const [editCatName, setEditCatName] = useState('');
  const [editCatDesc, setEditCatDesc] = useState('');
  const [savingCat, setSavingCat] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  // Certificate Designer state
  const [draftTemplate, setDraftTemplate] = useState<RecognitionTemplateConfig>(
    () => mergeRecognitionTemplate(templateConfig)
  );
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const logoUploadRef = useRef<HTMLInputElement | null>(null);
  const sigUploadRef = useRef<HTMLInputElement | null>(null);

  // Signature Draw Pad
  const [showDrawSig, setShowDrawSig] = useState(false);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);

  // Certificate History state
  const [historySearch, setHistorySearch] = useState('');
  const [historyEventFilter, setHistoryEventFilter] = useState<string>('all');
  const [historyCategoryFilter, setHistoryCategoryFilter] =
    useState<string>('all');
  const [selectedCertIds, setSelectedCertIds] = useState<Set<string>>(
    () => new Set()
  );
  const [deletingCertId, setDeletingCertId] = useState<string | null>(null);

  // Sync template draft when remote updates
  useEffect(() => {
    setDraftTemplate(mergeRecognitionTemplate(templateConfig));
  }, [templateConfig]);

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

  // Seed default 10 recognition categories once automatically if empty
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
              facilitator: facilitatorsVal,
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
            signatoryLabel: templateConfig.signatoryLabel.slice(0, 120),
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
        facilitator: facilitatorsVal,
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
        signatoryLabel: templateConfig.signatoryLabel.slice(0, 120),
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

  // Recognition Categories CRUD
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatError(null);
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
    try {
      await deleteDoc(doc(db, 'recognitionCategories', id));
    } catch (error) {
      setCatError('Unable to delete category.');
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `recognitionCategories/${id}`
      );
    }
  };

  // Certificate Designer Save & File Uploads
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
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      setTemplateSaved(true);
      window.setTimeout(() => setTemplateSaved(false), 2500);
    } catch (error) {
      setTemplateError('Unable to save recognition template settings.');
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

  const handleUploadSignature = async (file: File) => {
    setTemplateError(null);
    try {
      const dataUrl = await compressSignatureFile(file);
      setDraftTemplate((prev) => ({ ...prev, signatureDataUrl: dataUrl }));
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
    if (!canvas) return;
    setTemplateError(null);
    try {
      const dataUrl = compressSignatureCanvas(canvas);
      setDraftTemplate((prev) => ({ ...prev, signatureDataUrl: dataUrl }));
      setShowDrawSig(false);
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : 'Please draw a signature first.'
      );
    }
  };

  // History filtering
  const filteredCertificates = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return certificates.filter((cert) => {
      if (historyEventFilter !== 'all' && cert.eventId !== historyEventFilter) {
        return false;
      }
      if (
        historyCategoryFilter !== 'all' &&
        cert.categoryId !== historyCategoryFilter
      ) {
        return false;
      }
      if (q) {
        const hay =
          `${cert.participantName} ${cert.participantDepartment} ${cert.eventTitle} ${cert.categoryName} ${cert.certificateNumber}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    certificates,
    historySearch,
    historyEventFilter,
    historyCategoryFilter,
  ]);

  const toggleHistoryCertSelect = (id: string) => {
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
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `certificates/${id}`);
    } finally {
      setDeletingCertId(null);
    }
  };

  const selectedBulkCerts = useMemo(() => {
    if (selectedCertIds.size === 0) return filteredCertificates;
    return filteredCertificates.filter((c) => selectedCertIds.has(c.id));
  }, [filteredCertificates, selectedCertIds]);

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
      facilitator: ev?.facilitators || 'Ms. Elena Vance',
      organizer: branding?.organizationName || 'PRESENZA Academy',
      department:
        eventParticipants[0]?.record.classDepartment || 'Curriculum Team',
    });
  }, [
    draftTemplate.wordingTemplate,
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
      {/* Module Header & Sub-Navigation */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900">
            Certificates &amp; Recognition
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Select standout participants manually or using evaluation &amp; attendance records, customize portrait/landscape templates, and issue bulk verified PDF certificates.
          </p>
        </div>

        <div
          className="flex flex-wrap rounded-xl border border-slate-200 bg-slate-100 p-1 gap-1 self-start lg:self-auto"
          role="tablist"
          aria-label="Certificate and recognition sections"
        >
          {(
            [
              { id: 'issue', label: 'Award & Issue', icon: Award },
              { id: 'designer', label: 'Designer', icon: Palette },
              {
                id: 'categories',
                label: `Categories (${categories.length})`,
                icon: Tag,
              },
              {
                id: 'history',
                label: `History (${certificates.length})`,
                icon: History,
              },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={subTab === tab.id}
                onClick={() => setSubTab(tab.id)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                  subTab === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5 text-amber-700" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: AWARD & ISSUE CERTIFICATES */}
      {subTab === 'issue' && (
        <div className="space-y-6">
          {/* A. Event Integration Bar */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-6">
                <label
                  htmlFor="rec-event-select"
                  className="block text-xs font-bold uppercase tracking-wider text-blue-700 mb-1.5"
                >
                  1. Event Integration (Auto-Populated)
                </label>
                <select
                  id="rec-event-select"
                  value={selectedEventId}
                  onChange={(e) => {
                    setSelectedEventId(e.target.value);
                    setSelectedAttendanceIds(new Set());
                    setIssueError(null);
                    setIssueSuccess(null);
                  }}
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-semibold bg-slate-50 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {events.length === 0 && (
                    <option value="">No events created yet</option>
                  )}
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title} ({ev.eventDate})
                    </option>
                  ))}
                </select>
              </div>

              <div className="lg:col-span-6">
                <label
                  htmlFor="rec-category-select"
                  className="block text-xs font-bold uppercase tracking-wider text-amber-700 mb-1.5"
                >
                  2. Recognition Category
                </label>
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
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
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
                  <div className="text-slate-500 font-medium">
                    Topics / Sessions
                  </div>
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
              </div>
            )}
          </section>

          {/* C. Participant Selection (Manual vs Evaluation-Based) */}
          {selectedEvent && (
            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-slate-900">
                      3. Select Recipients
                    </h3>
                    <div
                      className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                      role="group"
                      aria-label="Participant selection method"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectionMode('manual')}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                          selectionMode === 'manual'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Option 1: Manual Selection
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectionMode('evaluation')}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                          selectionMode === 'evaluation'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Option 2: Evaluation-Based Review
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {selectionMode === 'evaluation'
                      ? 'Review check-in timeliness, arrival rank, and participant feedback alongside attendance to support your decision. Awards are only issued to people you explicitly select.'
                      : 'Search event attendance records and check the participants you wish to recognize.'}
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
                    className="min-h-[40px] px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
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
                <div className="mx-6 mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 font-semibold flex items-center justify-between gap-2">
                  <span>{issueSuccess}</span>
                  <button
                    type="button"
                    onClick={() => setSubTab('history')}
                    className="underline font-bold hover:text-emerald-950 shrink-0"
                  >
                    View &amp; Download in History
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
                        <th className="py-3 px-4 text-right">Category Status</th>
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
                                    className={`px-2 py-0.5 rounded font-semibold border ${
                                      record.status === 'On Time'
                                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                        : 'bg-amber-50 text-amber-800 border-amber-200'
                                    }`}
                                  >
                                    {record.status}
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
                                        <span>
                                          Gave {matchedFeedback.averageRating.toFixed(1)} ★ feedback
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
                                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>Already Issued</span>
                                  </span>
                                ) : (
                                  <span className="text-[11px] text-slate-400">
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
                    Or Issue Directly to a Manual Nominee ({selectedCategory?.name || 'Category'})
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
                    className="min-h-[40px] px-4 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <Award className="w-3.5 h-3.5" />
                    <span>Issue Single Certificate</span>
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
      )}

      {/* TAB 2: RECOGNITION CERTIFICATE DESIGNER */}
      {subTab === 'designer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Controls Column */}
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">
                Certificate Template Designer
              </h3>
              <button
                type="button"
                onClick={() => setDraftTemplate({ ...DEFAULT_RECOGNITION_TEMPLATE })}
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>

            {/* Orientation & Font */}
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

            {/* Color Presets + Custom Pickers */}
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-700">
                Color Theme Presets &amp; Custom Colors
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() =>
                      setDraftTemplate((prev) => ({
                        ...prev,
                        primaryColor: preset.primaryColor,
                        accentColor: preset.accentColor,
                        paperColor: preset.paperColor,
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[11px] font-semibold text-slate-700 inline-flex items-center gap-1.5"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full border border-slate-300"
                      style={{ backgroundColor: preset.primaryColor }}
                    />
                    <span>{preset.name}</span>
                  </button>
                ))}
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

            {/* Editable Title, Subtitle & Wording */}
            <div className="space-y-3">
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
            </div>

            {/* Logo & Signature Controls */}
            <div className="pt-3 border-t border-slate-200 space-y-3">
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
                ref={sigUploadRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleUploadSignature(file);
                }}
                className="hidden"
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

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700">
                    Authorized Signature
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => sigUploadRef.current?.click()}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1"
                    >
                      <ImagePlus className="w-3.5 h-3.5 text-blue-700" />
                      <span>Upload</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDrawSig((p) => !p)}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1"
                    >
                      <PenTool className="w-3.5 h-3.5 text-blue-700" />
                      <span>Draw</span>
                    </button>
                    {draftTemplate.signatureDataUrl && (
                      <button
                        type="button"
                        onClick={() =>
                          setDraftTemplate((prev) => ({
                            ...prev,
                            signatureDataUrl: '',
                          }))
                        }
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-700"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {showDrawSig && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                    <canvas
                      ref={drawCanvasRef}
                      width={360}
                      height={110}
                      onPointerDown={handleStartDraw}
                      onPointerMove={handleMoveDraw}
                      onPointerUp={handleEndDraw}
                      onPointerLeave={handleEndDraw}
                      className="w-full h-24 bg-white border border-slate-300 rounded-lg touch-none cursor-crosshair"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleClearDrawCanvas}
                        className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700"
                      >
                        Clear Pad
                      </button>
                      <button
                        type="button"
                        onClick={handleApplyDrawnSignature}
                        className="px-3 py-1 rounded-lg bg-blue-700 text-white text-xs font-semibold"
                      >
                        Use Signature
                      </button>
                    </div>
                  </div>
                )}

                <input
                  type="text"
                  maxLength={120}
                  value={draftTemplate.signatoryLabel}
                  onChange={(e) =>
                    setDraftTemplate((prev) => ({
                      ...prev,
                      signatoryLabel: e.target.value,
                    }))
                  }
                  placeholder="Signatory title / label..."
                  aria-label="Signatory label"
                  className="w-full min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-xl"
                />
              </div>

              {/* Field Visibility Toggles */}
              <div className="flex flex-wrap gap-3 pt-1 text-xs font-medium text-slate-700">
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
                  <span>Show Topic/Theme</span>
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draftTemplate.showFacilitator}
                    onChange={(e) =>
                      setDraftTemplate((prev) => ({
                        ...prev,
                        showFacilitator: e.target.checked,
                      }))
                    }
                  />
                  <span>Show Facilitator</span>
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

            {templateError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800">
                {templateError}
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
                {templateSaved ? 'Template Saved!' : 'Save Certificate Template'}
              </span>
            </button>
          </section>

          {/* Live Certificate Preview Column */}
          <section className="lg:col-span-7 bg-slate-100 border border-slate-200 rounded-2xl p-4 sm:p-6 flex flex-col items-center justify-center">
            <div className="w-full flex items-center justify-between mb-3 text-xs text-slate-600">
              <span className="font-bold uppercase tracking-wider">
                Live Certificate Preview ({draftTemplate.orientation})
              </span>
              <span className="font-mono-tabular">
                A4 {draftTemplate.orientation === 'portrait' ? '210 × 297 mm' : '297 × 210 mm'}
              </span>
            </div>

            <div
              className={`w-full shadow-lg rounded-sm relative overflow-hidden flex flex-col justify-between p-6 sm:p-8 text-center transition-all ${
                draftTemplate.orientation === 'portrait'
                  ? 'max-w-[440px] aspect-[210/297]'
                  : 'max-w-[680px] aspect-[297/210]'
              }`}
              style={{
                backgroundColor: draftTemplate.paperColor,
                border: `4px solid ${draftTemplate.primaryColor}`,
                fontFamily:
                  draftTemplate.fontFamily === 'times'
                    ? 'Georgia, "Times New Roman", serif'
                    : draftTemplate.fontFamily === 'courier'
                    ? 'ui-monospace, monospace'
                    : 'system-ui, sans-serif',
              }}
            >
              {/* Inner accent border */}
              <div
                className="absolute inset-2 pointer-events-none"
                style={{ border: `1.5px solid ${draftTemplate.accentColor}` }}
              />

              <div className="relative z-10 flex flex-col items-center space-y-2 pt-2">
                {previewLogoUrl && (
                  <img
                    src={previewLogoUrl}
                    alt="Organization logo"
                    className="h-10 w-10 object-contain"
                  />
                )}
                <div
                  className="text-[10px] font-bold tracking-widest uppercase"
                  style={{ color: draftTemplate.accentColor }}
                >
                  {branding?.organizationName?.trim() || 'PRESENZA'}
                </div>
                <h4
                  className="text-xl sm:text-2xl font-bold tracking-tight leading-tight"
                  style={{ color: draftTemplate.primaryColor }}
                >
                  {draftTemplate.title}
                </h4>
                {draftTemplate.subtitle && (
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {draftTemplate.subtitle}
                  </p>
                )}

                <div
                  className="mt-1 px-4 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-slate-50 border"
                  style={{
                    color: draftTemplate.accentColor,
                    borderColor: draftTemplate.accentColor,
                  }}
                >
                  {selectedCategory?.name || 'Best Participant'}
                </div>
              </div>

              <div className="relative z-10 my-auto py-3 space-y-2">
                <p className="text-[11px] text-slate-500">
                  This recognition award is proudly presented to
                </p>
                <div
                  className="text-2xl sm:text-3xl font-bold"
                  style={{ color: draftTemplate.primaryColor }}
                >
                  {eventParticipants[0]?.record.fullName || 'Dr. Sarah Jenkins'}
                </div>
                <div
                  className="text-xs font-bold"
                  style={{ color: draftTemplate.accentColor }}
                >
                  {eventParticipants[0]?.record.classDepartment ||
                    'Curriculum Department'}
                </div>
                <div className="w-40 h-px bg-slate-300 mx-auto" />
                <p className="text-xs text-slate-700 leading-relaxed max-w-lg mx-auto">
                  {previewSampleWording}
                </p>
                {draftTemplate.showTopic && (
                  <div
                    className="text-[11px] font-bold pt-1"
                    style={{ color: draftTemplate.primaryColor }}
                  >
                    Topic:{' '}
                    {selectedEvent?.topic?.trim() ||
                      selectedEvent?.category ||
                      'Instructional Excellence'}
                  </div>
                )}
              </div>

              <div className="relative z-10 space-y-2 pb-1">
                <div className="grid grid-cols-3 gap-3 items-end text-[10px]">
                  <div>
                    <div
                      className="font-bold pb-0.5"
                      style={{ color: draftTemplate.primaryColor }}
                    >
                      {formatLocalDateYmd(new Date())}
                    </div>
                    <div className="border-t border-slate-300 pt-1 text-slate-500">
                      Date Issued
                    </div>
                  </div>
                  <div className="flex flex-col items-center">
                    {draftTemplate.signatureDataUrl && (
                      <img
                        src={draftTemplate.signatureDataUrl}
                        alt="Authorized signature"
                        className="h-7 object-contain mb-0.5"
                      />
                    )}
                    <div
                      className="w-full border-t border-slate-300 pt-1 font-bold truncate"
                      style={{ color: draftTemplate.primaryColor }}
                    >
                      {draftTemplate.signatoryLabel || 'Authorized Coordinator'}
                    </div>
                  </div>
                  <div>
                    {draftTemplate.showFacilitator ? (
                      <>
                        <div
                          className="font-bold pb-0.5 truncate"
                          style={{ color: draftTemplate.primaryColor }}
                        >
                          {selectedEvent?.facilitators?.trim() ||
                            'Session Facilitator'}
                        </div>
                        <div className="border-t border-slate-300 pt-1 text-slate-500">
                          Facilitator
                        </div>
                      </>
                    ) : (
                      <div />
                    )}
                  </div>
                </div>

                {draftTemplate.showCertificateId && (
                  <div className="font-mono-tabular text-[9px] text-slate-400">
                    Certificate ID: PRZ-2026-SAMPLE · Event:{' '}
                    {selectedEvent?.title || 'Workshop Session'}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* TAB 3: RECOGNITION CATEGORIES CRUD */}
      {subTab === 'categories' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Manage Recognition Categories
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Add, rename, edit descriptions, or delete recognition award titles used for certificates.
              </p>
            </div>
            <button
              type="button"
              disabled={seedingCategories}
              onClick={() => void seedDefaultCategories()}
              className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5 self-start sm:self-auto"
            >
              {seedingCategories ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-amber-600" />
              )}
              <span>Restore 10 Default Categories</span>
            </button>
          </div>

          <form
            onSubmit={handleAddCategory}
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-4 rounded-xl border border-slate-200 bg-slate-50"
          >
            <input
              type="text"
              required
              maxLength={100}
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="New recognition category name..."
              className="sm:col-span-4 min-h-[42px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <input
              type="text"
              maxLength={300}
              value={newCatDesc}
              onChange={(e) => setNewCatDesc(e.target.value)}
              placeholder="Short criteria description (optional)"
              className="sm:col-span-6 min-h-[42px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={savingCat}
              className="sm:col-span-2 min-h-[42px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Add</span>
            </button>
          </form>

          {catError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
              {catError}
            </div>
          )}

          <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white hover:bg-slate-50/60"
              >
                {editingCat?.id === cat.id ? (
                  <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <input
                      type="text"
                      maxLength={100}
                      value={editCatName}
                      onChange={(e) => setEditCatName(e.target.value)}
                      className="min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg font-semibold"
                    />
                    <input
                      type="text"
                      maxLength={300}
                      value={editCatDesc}
                      onChange={(e) => setEditCatDesc(e.target.value)}
                      className="flex-1 min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={savingCat}
                        onClick={() => void handleSaveEditCategory()}
                        className="min-h-[36px] px-3 py-1 rounded-lg bg-emerald-700 text-white text-xs font-semibold"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingCat(null)}
                        className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900">
                        {cat.name}
                      </div>
                      {cat.description && (
                        <div className="text-xs text-slate-500 mt-0.5">
                          {cat.description}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingCat(cat);
                          setEditCatName(cat.name);
                          setEditCatDesc(cat.description);
                        }}
                        className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 inline-flex items-center gap-1"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Rename / Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteCategory(cat.id)}
                        className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center"
                        aria-label={`Delete ${cat.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: ISSUED CERTIFICATE HISTORY & BULK PDF */}
      {subTab === 'history' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="p-5 sm:p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Issued Recognition Certificate History ({filteredCertificates.length})
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Search by participant, event, category, or Certificate ID. Download single or bulk multi-page PDFs or print directly.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={selectedBulkCerts.length === 0}
                onClick={() =>
                  downloadRecognitionCertificatesPdf(
                    selectedBulkCerts,
                    templateConfig,
                    branding
                  )
                }
                className="min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>
                  {selectedCertIds.size > 0
                    ? `Download Selected (${selectedCertIds.size}) PDF`
                    : `Download All Filtered (${filteredCertificates.length}) PDF`}
                </span>
              </button>
              <button
                type="button"
                disabled={selectedBulkCerts.length === 0}
                onClick={() =>
                  printRecognitionCertificatesPdf(
                    selectedBulkCerts,
                    templateConfig,
                    branding
                  )
                }
                className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print</span>
              </button>
            </div>
          </div>

          {/* Search & Filters */}
          <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Search recipient, category, or ID..."
                className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl"
              />
            </div>

            <select
              value={historyEventFilter}
              onChange={(e) => setHistoryEventFilter(e.target.value)}
              aria-label="Filter certificates by event"
              className="min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl text-slate-800"
            >
              <option value="all">All Events</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.title}
                </option>
              ))}
            </select>

            <select
              value={historyCategoryFilter}
              onChange={(e) => setHistoryCategoryFilter(e.target.value)}
              aria-label="Filter certificates by category"
              className="min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl text-slate-800"
            >
              <option value="all">All Recognition Categories</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          {filteredCertificates.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <Award className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="text-sm font-semibold text-slate-900">
                No certificates match the current search
              </p>
              <p className="text-xs text-slate-500">
                Switch to &ldquo;Award &amp; Issue&rdquo; to select recipients and generate recognition certificates.
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
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4">Event &amp; Topic</th>
                    <th className="py-3 px-4">Issued Date</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredCertificates.map((cert) => {
                    const picked = selectedCertIds.has(cert.id);
                    return (
                      <tr key={cert.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => toggleHistoryCertSelect(cert.id)}
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
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                            {cert.categoryName}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className="font-semibold text-slate-800">
                            {cert.eventTitle}
                          </div>
                          {cert.eventTopic && (
                            <div className="text-slate-500 truncate max-w-[200px]">
                              {cert.eventTopic}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono-tabular text-xs text-slate-600 whitespace-nowrap">
                          {cert.issueDate}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                downloadRecognitionCertificatesPdf(
                                  [cert],
                                  templateConfig,
                                  branding
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
                                  branding
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
        </div>
      )}
    </div>
  );
}
