import { Timestamp } from 'firebase/firestore';

export type Role = 'admin' | 'reviewer' | 'recorder' | 'pending' | 'disabled';

export const ROLES: { value: Role; label: string; description: string }[] = [
  { value: 'admin', label: 'Admin', description: 'Everything, including script, datasets, training and team' },
  { value: 'reviewer', label: 'Reviewer', description: 'Records and reviews clips' },
  { value: 'recorder', label: 'Recorder', description: 'Records clips' },
  { value: 'pending', label: 'Pending', description: 'Waiting for approval' },
  { value: 'disabled', label: 'Disabled', description: 'No access' },
];

export const MEMBER_ROLES: Role[] = ['admin', 'reviewer', 'recorder'];

export interface SpeakerProfile {
  name: string;
  gender: '' | 'female' | 'male' | 'other';
  ageRange: '' | '18-24' | '25-34' | '35-44' | '45-54' | '55-64' | '65+';
  region: string;
  languages: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  role: Role;
  speaker?: SpeakerProfile;
  createdAt?: Timestamp;
  lastSeenAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type SentenceStatus = 'open' | 'recorded';

export interface Sentence {
  id: string;
  text: string;
  category: string;
  seq: number;
  status: SentenceStatus;
  recordCount: number;
  hasDigits: boolean;
  createdAt?: Timestamp;
  createdBy?: string;
  lastRecordedAt?: Timestamp;
  lastRecordedBy?: string;
}

export type ClipStatus = 'pending' | 'approved' | 'rejected';

export type QcFlag =
  | 'clipping'
  | 'too_quiet'
  | 'too_loud'
  | 'too_short'
  | 'long_lead'
  | 'long_tail'
  | 'fast'
  | 'slow'
  | 'no_speech';

export interface QcReport {
  peakDb: number;
  rmsDb: number;
  clippedSamples: number;
  leadingSilence: number;
  trailingSilence: number;
  speechDuration: number;
  charsPerSec: number;
  flags: QcFlag[];
}

export interface Clip {
  id: string;
  sentenceId: string;
  text: string;
  originalText: string;
  textEdited: boolean;
  category: string;
  speakerId: string;
  speakerName: string;
  storagePath: string;
  durationSec: number;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  sizeBytes: number;
  qc: QcReport;
  hasFlags: boolean;
  status: ClipStatus;
  source: 'studio' | 'call';
  reviewNote?: string;
  reviewedBy?: string;
  reviewedByName?: string;
  reviewedAt?: Timestamp;
  createdAt?: Timestamp;
}

export type DatasetTask = 'tts' | 'stt';

export interface Dataset {
  id: string;
  name: string;
  task: DatasetTask;
  clipCount: number;
  trainCount: number;
  evalCount: number;
  durationSec: number;
  speakers: { id: string; name: string; clips: number }[];
  manifestPath: string;
  manifestUri: string;
  filters: {
    speakerId: string | null;
    includeFlagged: boolean;
    minDuration: number;
    maxDuration: number;
    evalPercent: number;
  };
  notes: string;
  createdAt?: Timestamp;
  createdBy?: string;
  createdByName?: string;
}

export type RunStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TrainingRun {
  id: string;
  name: string;
  task: DatasetTask;
  datasetId: string;
  datasetName: string;
  manifestUri: string;
  baseModel: string;
  machine: string;
  hyperparams: { epochs: number; learningRate: number; batchSize: number };
  gitCommit: string;
  vertexJobId: string;
  outputUri: string;
  status: RunStatus;
  metrics: { wer?: number | null; cer?: number | null; mos?: number | null };
  notes: string;
  createdAt?: Timestamp;
  createdBy?: string;
  createdByName?: string;
  updatedAt?: Timestamp;
}

export interface DailyStat {
  date: string;
  clips: number;
  seconds: number;
}

export interface ScriptMeta {
  categories: string[];
}
