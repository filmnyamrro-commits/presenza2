import type { Timestamp } from 'firebase/firestore';

export type EventCategory = string;

export type EventStatus = 'active' | 'closed';

export type AttendanceStatus = 'On Time' | 'Late';

export interface EventRecord {
  id: string;
  title: string;
  category: EventCategory;
  description: string;
  venue: string;
  eventDate: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  lateCutoffTime: string; // HH:MM
  cutoffTimestamp: Timestamp;
  status: EventStatus;
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  departmentLabel?: string;
  departmentPresets?: string;
  consentText?: string;
  facilitators?: string;
  principalName?: string;
  requireParticipantLogin?: boolean;
  theme?: string;
  topic?: string;
}

export interface AttendanceRecord {
  id: string;
  eventId: string;
  eventName: string;
  fullName: string;
  classDepartment: string;
  photoDataUrl: string;
  photoConsent: boolean;
  attendanceDate: string; // YYYY-MM-DD
  checkInTime: string;
  serverTimestamp: Timestamp;
  status: AttendanceStatus;
  lateExcuse: string;
  participantEmail?: string;
  participantUid?: string;
}

export interface CheckInReceipt {
  id: string;
  eventId: string;
  eventName: string;
  fullName: string;
  classDepartment: string;
  photoDataUrl: string;
  attendanceDate: string;
  checkInTime: string;
  recordedAtIso: string;
  status: AttendanceStatus;
  lateExcuse: string;
  participantEmail?: string;
}

export interface OrganizationBranding {
  organizationName: string;
  logoDataUrl: string;
}

export interface AuthorizedAdminRecord {
  id: string;
  email: string;
  displayName: string;
  addedByUid: string;
  addedByEmail: string;
  createdAt: Timestamp;
}

export type CertificateThemeId =
  | 'classic-navy'
  | 'emerald-academic'
  | 'royal-slate'
  | 'crimson-crest'
  | 'teal-modern';

export type CertificateElementKey =
  | 'orgLogo'
  | 'orgName'
  | 'kicker'
  | 'title'
  | 'subtitle'
  | 'rankBadge'
  | 'photo'
  | 'awardedTo'
  | 'recipientName'
  | 'department'
  | 'citation'
  | 'seal'
  | 'dateFooter'
  | 'facilitatorBlock'
  | 'principalBlock';

export interface CertificateElementConfig {
  visible: boolean;
  x: number; // mm from left edge (0..297 on A4 landscape)
  y: number; // mm from top edge (0..210 on A4 landscape)
}

export type CertificateElementsMap = Record<
  CertificateElementKey,
  CertificateElementConfig
>;

export interface CertificateSettings {
  themeId: CertificateThemeId;
  backgroundDataUrl: string;
  backgroundOpacity: number; // 0..100
  facilitatorSignatureDataUrl: string;
  principalSignatureDataUrl: string;
  elements: CertificateElementsMap;
}

// Module 1: Participant Feedback & Evaluation
export interface FeedbackRatingCriterion {
  id: string;
  label: string;
  active: boolean;
  required: boolean;
}

export interface FeedbackStatementCategory {
  id: string;
  name: string;
  sentiment: 'positive' | 'improvement';
}

export interface FeedbackStatement {
  id: string;
  categoryId: string;
  text: string;
  active: boolean;
  required: boolean;
}

export interface FeedbackConfig {
  eventId: string; // 'default' or specific event ID
  introNote: string;
  requireWrittenComment: boolean;
  ratingCriteria: FeedbackRatingCriterion[];
  categories: FeedbackStatementCategory[];
  statements: FeedbackStatement[];
}

export interface FeedbackRatingEntry {
  criterionId: string;
  label: string;
  score: number; // 1..5
}

export interface FeedbackStatementSelection {
  statementId: string;
  categoryId: string;
  categoryName: string;
  sentiment: 'positive' | 'improvement';
  text: string;
}

export interface FeedbackSubmissionRecord {
  id: string;
  eventId: string;
  eventTitle: string;
  eventDate: string;
  eventVenue: string;
  facilitatorName: string;
  sessionTopic: string;
  ratings: FeedbackRatingEntry[];
  averageRating: number;
  selectedStatements: FeedbackStatementSelection[];
  writtenComment: string;
  participantName?: string;
  participantDepartment?: string;
  participantEmail?: string;
  attendanceId?: string;
  clientSubmissionToken: string;
  serverTimestamp: Timestamp;
}

// Module 2: Certificates & Recognition
export interface RecognitionCategory {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  createdByUid: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type RecognitionFontFamily = 'times' | 'helvetica' | 'courier';
export type RecognitionOrientation = 'landscape' | 'portrait';

export interface RecognitionTemplateConfig {
  orientation: RecognitionOrientation;
  title: string;
  subtitle: string;
  wordingTemplate: string;
  fontFamily: RecognitionFontFamily;
  primaryColor: string; // Hex e.g. #0F172A
  accentColor: string; // Hex e.g. #B45309
  paperColor: string; // Hex e.g. #FFFFFF
  customLogoDataUrl: string;
  signatureDataUrl: string;
  signatoryLabel: string;
  showTopic: boolean;
  showFacilitator: boolean;
  showCertificateId: boolean;
}

export interface IssuedCertificateRecord {
  id: string;
  certificateNumber: string;
  dedupeKey: string;
  eventId: string;
  eventTitle: string;
  eventDate: string;
  eventVenue: string;
  eventTheme: string;
  eventTopic: string;
  facilitators: string;
  organizerName: string;
  attendanceId: string;
  participantName: string;
  participantDepartment: string;
  participantEmail: string;
  categoryId: string;
  categoryName: string;
  issueDate: string; // YYYY-MM-DD
  selectionMethod: 'manual' | 'evaluation';
  orientation: RecognitionOrientation;
  certificateTitle: string;
  certificateSubtitle: string;
  wordingText: string;
  fontFamily: RecognitionFontFamily;
  primaryColor: string;
  accentColor: string;
  paperColor: string;
  signatoryLabel: string;
  issuedByUid: string;
  issuedByEmail: string;
  createdAt: Timestamp;
}

// Module 3: AI Voice Check-in Announcement
export type VoiceLanguage = 'en-US' | 'id-ID';
export type VoiceEngineMode = 'auto' | 'ai' | 'browser';
export type VoicePresetId =
  | 'en-prof-male'
  | 'en-friendly-male'
  | 'en-prof-female'
  | 'en-friendly-female'
  | 'id-male'
  | 'id-female'
  | 'browser-custom';

export interface VoiceAnnouncementSettings {
  enabled: boolean;
  engineMode: VoiceEngineMode;
  voiceId: VoicePresetId;
  browserVoiceUri: string;
  language: VoiceLanguage;
  speakingRate: number;
  volume: number;
  englishTemplate: string;
  indonesianTemplate: string;
  announceOnDashboard: boolean;
  announceOnCheckIn: boolean;
}

// Module 4: Live Animated Attendance Dashboard
export type LiveBoardAnimationStyle =
  | 'zoom-bounce'
  | 'slide-up'
  | 'slide-side'
  | 'fade-scale';

export type LiveBoardCardLayout =
  | 'portrait-card'
  | 'horizontal-tile'
  | 'compact-badge';

export type LiveBoardSizeScale = 'auto' | 'sm' | 'md' | 'lg' | 'xl';

export type LiveBoardThemeId =
  | 'clean-light'
  | 'slate-conference'
  | 'midnight-projector'
  | 'emerald-hall'
  | 'warm-ivory';

export type LiveBoardDisplayMode =
  | 'fit'
  | 'auto-paginate'
  | 'rotating'
  | 'manual';

export interface LiveBoardSettings {
  animationStyle: LiveBoardAnimationStyle;
  animationDurationMs: number;
  cardLayout: LiveBoardCardLayout;
  columnsMode: 'auto' | 'manual';
  manualColumns: number;
  photoSize: LiveBoardSizeScale;
  fontSize: LiveBoardSizeScale;
  backgroundTheme: LiveBoardThemeId;
  displayMode: LiveBoardDisplayMode;
  rotationIntervalSec: number;
  disableAnimations: boolean;
}

// Module 5: Cross-Device Owner Verification & Device Authorization
export interface AuthorizedDeviceRecord {
  deviceId: string;
  deviceName: string;
  userAgentSummary: string;
  status: 'active' | 'revoked';
  authorizedBy: 'code' | 'owner-google' | 'owner-direct';
  authorizedAtIso: string;
  lastSeenAtIso: string;
  revokedAtIso?: string;
}

export interface PendingDeviceChallengeSummary {
  challengeId: string;
  deviceId: string;
  deviceName: string;
  userAgentSummary: string;
  expiresAtIso: string;
  createdAtIso: string;
  attempts: number;
  maxAttempts: number;
  emailSent: boolean;
}

export interface DeviceSecurityPolicy {
  allowDirectQrWithoutDeviceAuth: boolean;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}
