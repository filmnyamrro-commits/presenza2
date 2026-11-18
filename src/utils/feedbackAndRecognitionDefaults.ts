import type {
  FeedbackConfig,
  FeedbackRatingCriterion,
  FeedbackStatement,
  FeedbackStatementCategory,
  RecognitionTemplateConfig,
} from '../types';

export const DEFAULT_RATING_CRITERIA: FeedbackRatingCriterion[] = [
  {
    id: 'crit_overall',
    label: 'Overall event satisfaction',
    active: true,
    required: true,
  },
  {
    id: 'crit_facilitator',
    label: 'Quality of the facilitator',
    active: true,
    required: true,
  },
  {
    id: 'crit_relevance',
    label: 'Relevance of the material',
    active: true,
    required: true,
  },
  {
    id: 'crit_clarity',
    label: 'Clarity of presentation',
    active: true,
    required: true,
  },
  {
    id: 'crit_organization',
    label: 'Organization and event management',
    active: true,
    required: true,
  },
  {
    id: 'crit_facilities',
    label: 'Facilities and supporting resources',
    active: true,
    required: false,
  },
];

export const DEFAULT_FEEDBACK_CATEGORIES: FeedbackStatementCategory[] = [
  {
    id: 'cat_positive',
    name: 'Positive Feedback',
    sentiment: 'positive',
  },
  {
    id: 'cat_suggestions',
    name: 'Suggestions & Areas to Improve',
    sentiment: 'improvement',
  },
];

export const DEFAULT_FEEDBACK_STATEMENTS: FeedbackStatement[] = [
  {
    id: 'stmt_pos_1',
    categoryId: 'cat_positive',
    text: 'The materials were useful and relevant.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_pos_2',
    categoryId: 'cat_positive',
    text: 'The facilitator explained the topic clearly.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_pos_3',
    categoryId: 'cat_positive',
    text: 'The activities encouraged active participation.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_pos_4',
    categoryId: 'cat_positive',
    text: 'The event met my expectations.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_pos_5',
    categoryId: 'cat_positive',
    text: 'I gained new knowledge and skills.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_pos_6',
    categoryId: 'cat_positive',
    text: 'The event was well organized.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_imp_1',
    categoryId: 'cat_suggestions',
    text: 'More practical activities are needed.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_imp_2',
    categoryId: 'cat_suggestions',
    text: 'More time should be allocated for discussion.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_imp_3',
    categoryId: 'cat_suggestions',
    text: 'Additional learning materials would be helpful.',
    active: true,
    required: false,
  },
  {
    id: 'stmt_imp_4',
    categoryId: 'cat_suggestions',
    text: 'The session should provide more real-life examples.',
    active: true,
    required: false,
  },
];

export function buildDefaultFeedbackConfig(eventId = 'default'): FeedbackConfig {
  return {
    eventId,
    introNote:
      'Your honest feedback helps us improve future workshops, seminars, and professional development sessions.',
    requireWrittenComment: false,
    ratingCriteria: DEFAULT_RATING_CRITERIA.map((c) => ({ ...c })),
    categories: DEFAULT_FEEDBACK_CATEGORIES.map((c) => ({ ...c })),
    statements: DEFAULT_FEEDBACK_STATEMENTS.map((s) => ({ ...s })),
  };
}

export function mergeFeedbackConfig(
  partial?: Partial<FeedbackConfig> | null,
  fallbackEventId = 'default'
): FeedbackConfig {
  const base = buildDefaultFeedbackConfig(partial?.eventId || fallbackEventId);
  if (!partial) return base;
  return {
    eventId: partial.eventId || fallbackEventId,
    introNote:
      typeof partial.introNote === 'string'
        ? partial.introNote.slice(0, 400)
        : base.introNote,
    requireWrittenComment:
      typeof partial.requireWrittenComment === 'boolean'
        ? partial.requireWrittenComment
        : base.requireWrittenComment,
    ratingCriteria:
      Array.isArray(partial.ratingCriteria) && partial.ratingCriteria.length > 0
        ? partial.ratingCriteria.slice(0, 12).map((c) => ({
            id: String(c.id || ''),
            label: String(c.label || '').slice(0, 120),
            active: typeof c.active === 'boolean' ? c.active : true,
            required: typeof c.required === 'boolean' ? c.required : false,
          }))
        : base.ratingCriteria,
    categories:
      Array.isArray(partial.categories) && partial.categories.length > 0
        ? partial.categories.slice(0, 12).map((c) => ({
            id: String(c.id || ''),
            name: String(c.name || '').slice(0, 80),
            sentiment:
              c.sentiment === 'improvement' ? 'improvement' : 'positive',
          }))
        : base.categories,
    statements: Array.isArray(partial.statements)
      ? partial.statements.slice(0, 40).map((s) => ({
          id: String(s.id || ''),
          categoryId: String(s.categoryId || 'cat_positive'),
          text: String(s.text || '').slice(0, 200),
          active: typeof s.active === 'boolean' ? s.active : true,
          required: typeof s.required === 'boolean' ? s.required : false,
        }))
      : base.statements,
  };
}

export const DEFAULT_RECOGNITION_CATEGORIES: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  sortOrder: number;
}> = [
  {
    id: 'rec_best_participant',
    name: 'Best Participant',
    description:
      'Overall excellence in engagement, preparation, and positive workshop contribution.',
    sortOrder: 1,
  },
  {
    id: 'rec_most_active',
    name: 'Most Active Participant',
    description:
      'Consistent, energetic participation throughout discussions and hands-on activities.',
    sortOrder: 2,
  },
  {
    id: 'rec_best_collaboration',
    name: 'Best Collaboration',
    description:
      'Exemplary partner and group collaboration supporting fellow participants.',
    sortOrder: 3,
  },
  {
    id: 'rec_outstanding_contribution',
    name: 'Most Outstanding Contribution',
    description:
      'Valuable insights, resources, or practical input that elevated the entire session.',
    sortOrder: 4,
  },
  {
    id: 'rec_innovative_ideas',
    name: 'Most Innovative Ideas',
    description:
      'Creative, forward-thinking approaches and fresh solutions shared during the session.',
    sortOrder: 5,
  },
  {
    id: 'rec_critical_thinking',
    name: 'Best Question or Critical Thinking',
    description:
      'Thought-provoking questions and analytical depth that sparked meaningful reflection.',
    sortOrder: 6,
  },
  {
    id: 'rec_enthusiastic_learner',
    name: 'Most Enthusiastic Learner',
    description:
      'Infectious curiosity, openness to feedback, and eagerness to master new concepts.',
    sortOrder: 7,
  },
  {
    id: 'rec_best_teamwork',
    name: 'Best Teamwork',
    description:
      'Strong team spirit, shared responsibility, and constructive group synergy.',
    sortOrder: 8,
  },
  {
    id: 'rec_most_improved',
    name: 'Most Improved Participant',
    description:
      'Noticeable growth, confidence, and skill progression across session milestones.',
    sortOrder: 9,
  },
  {
    id: 'rec_outstanding_leadership',
    name: 'Outstanding Leadership',
    description:
      'Guiding peers with clarity, initiative, and encouraging group facilitation.',
    sortOrder: 10,
  },
];

export const DEFAULT_RECOGNITION_TEMPLATE: RecognitionTemplateConfig = {
  orientation: 'landscape',
  title: 'CERTIFICATE OF RECOGNITION',
  subtitle: 'AWARDED FOR EXEMPLARY PARTICIPATION & ACHIEVEMENT',
  wordingTemplate:
    'This certificate is proudly presented to {{participant}} in recognition of being named {{category}} during "{{event}}" held on {{date}} at {{venue}}.',
  fontFamily: 'times',
  primaryColor: '#0F172A',
  accentColor: '#B45309',
  paperColor: '#FFFFFF',
  customLogoDataUrl: '',
  signatureDataUrl: '',
  signatoryLabel: 'Authorized Program Coordinator',
  showTopic: true,
  showFacilitator: true,
  showCertificateId: true,
};

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

export function mergeRecognitionTemplate(
  partial?: Partial<RecognitionTemplateConfig> | null
): RecognitionTemplateConfig {
  if (!partial) return { ...DEFAULT_RECOGNITION_TEMPLATE };
  return {
    orientation:
      partial.orientation === 'portrait' ? 'portrait' : 'landscape',
    title:
      typeof partial.title === 'string' && partial.title.trim().length >= 2
        ? partial.title.slice(0, 120)
        : DEFAULT_RECOGNITION_TEMPLATE.title,
    subtitle:
      typeof partial.subtitle === 'string'
        ? partial.subtitle.slice(0, 140)
        : DEFAULT_RECOGNITION_TEMPLATE.subtitle,
    wordingTemplate:
      typeof partial.wordingTemplate === 'string' &&
      partial.wordingTemplate.trim().length >= 5
        ? partial.wordingTemplate.slice(0, 600)
        : DEFAULT_RECOGNITION_TEMPLATE.wordingTemplate,
    fontFamily:
      partial.fontFamily === 'helvetica' || partial.fontFamily === 'courier'
        ? partial.fontFamily
        : 'times',
    primaryColor:
      typeof partial.primaryColor === 'string' &&
      HEX_COLOR_REGEX.test(partial.primaryColor)
        ? partial.primaryColor
        : DEFAULT_RECOGNITION_TEMPLATE.primaryColor,
    accentColor:
      typeof partial.accentColor === 'string' &&
      HEX_COLOR_REGEX.test(partial.accentColor)
        ? partial.accentColor
        : DEFAULT_RECOGNITION_TEMPLATE.accentColor,
    paperColor:
      typeof partial.paperColor === 'string' &&
      HEX_COLOR_REGEX.test(partial.paperColor)
        ? partial.paperColor
        : DEFAULT_RECOGNITION_TEMPLATE.paperColor,
    customLogoDataUrl:
      typeof partial.customLogoDataUrl === 'string'
        ? partial.customLogoDataUrl
        : '',
    signatureDataUrl:
      typeof partial.signatureDataUrl === 'string'
        ? partial.signatureDataUrl
        : '',
    signatoryLabel:
      typeof partial.signatoryLabel === 'string'
        ? partial.signatoryLabel.slice(0, 120)
        : DEFAULT_RECOGNITION_TEMPLATE.signatoryLabel,
    showTopic:
      typeof partial.showTopic === 'boolean'
        ? partial.showTopic
        : DEFAULT_RECOGNITION_TEMPLATE.showTopic,
    showFacilitator:
      typeof partial.showFacilitator === 'boolean'
        ? partial.showFacilitator
        : DEFAULT_RECOGNITION_TEMPLATE.showFacilitator,
    showCertificateId:
      typeof partial.showCertificateId === 'boolean'
        ? partial.showCertificateId
        : DEFAULT_RECOGNITION_TEMPLATE.showCertificateId,
  };
}

export function buildCertificateDedupeKey(
  eventId: string,
  categoryId: string,
  participantName: string,
  participantEmail?: string
): string {
  const identity =
    participantEmail && participantEmail.trim()
      ? participantEmail.trim().toLowerCase()
      : participantName
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ');
  return `${eventId}::${categoryId}::${identity}`.slice(0, 240);
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildCertificateDocId(dedupeKey: string): string {
  const hashA = fnv1aHex(dedupeKey);
  const hashB = fnv1aHex(`${dedupeKey}::presenza`);
  return `cert_${hashA}${hashB}`;
}

export function generateCertificateNumber(): string {
  const year = new Date().getFullYear();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = new Uint8Array(6);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) {
      suffix += alphabet[bytes[i] % alphabet.length];
    }
  } else {
    for (let i = 0; i < 6; i++) {
      suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  }
  return `PRZ-${year}-${suffix}`;
}

export function interpolateRecognitionWording(
  templateStr: string,
  vars: {
    participant: string;
    category: string;
    event: string;
    date: string;
    venue: string;
    topic?: string;
    theme?: string;
    facilitator?: string;
    organizer?: string;
    department?: string;
  }
): string {
  const map: Record<string, string> = {
    participant: vars.participant || 'Participant',
    category: vars.category || 'Recognition Award',
    event: vars.event || 'Workshop Session',
    date: vars.date || '',
    venue: vars.venue || 'Event Venue',
    topic: vars.topic || 'General Session',
    theme: vars.theme || '',
    facilitator: vars.facilitator || 'Session Facilitator',
    organizer: vars.organizer || 'PRESENZA',
    department: vars.department || '',
  };

  return templateStr
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      const lower = key.toLowerCase();
      return lower in map ? map[lower] : _match;
    })
    .trim();
}
