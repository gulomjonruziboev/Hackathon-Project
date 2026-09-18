import { Schema, model } from 'mongoose';
import { baseOptions, uuidId, type BaseFields } from './base.js';
import type { ProviderMetadata } from '../llm/LLMAdapter.js';
import type { ExtractionPayload } from '../llm/extractionSchema.js';
import type { CandidateFact } from '../services/extractionService.js';

export const DOCUMENT_STATUSES = ['UPLOADED', 'TEXT_READY', 'TEXT_FAILED'] as const;
export const EXTRACTION_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'MANUAL_REQUIRED'] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export type DocumentRecord = BaseFields & {
  clinic_id: string;
  patient_id: string;
  /** Generated storage key; the user-supplied filename never reaches the path (spec 13). */
  storage_key: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  page_count: number | null;
  extracted_text: string;
  page_texts: string[];
  parser_version: string | null;
  /** Cloud extraction is refused unless the document is marked synthetic (AI-08). */
  is_synthetic: boolean;
  status: DocumentStatus;
  error_code: string | null;
  uploaded_by: string | null;
};

export type Extraction = BaseFields & {
  clinic_id: string;
  patient_id: string;
  document_id: string;
  schema_version: string;
  prompt_version: string;
  parser_version: string;
  provider: string;
  provider_model: string;
  model_revision: string | null;
  /** 1-based page numbers actually sent to the model (supplement 9). */
  page_selection: number[];
  chunk_count: number;
  /** True when the payload did not come from a live model call (main spec 9.4). */
  is_recorded_demo: boolean;
  status: ExtractionStatus;
  error_code: string | null;
  error_message: string | null;
  /** provider / model_id / latency_ms / tokens / finish_status / cache_hit (supplement 11). */
  provider_metadata: ProviderMetadata | Record<string, never>;
  cache_hit: boolean;
  repair_attempted: boolean;
  /** Candidate facts awaiting doctor confirmation; never used for analysis as-is (FR-06). */
  candidates: CandidateFact[];
  warnings: string[];
  confirmed_at: Date | null;
  confirmed_by: string | null;
  resulting_profile_revision_id: string | null;
  created_by: string | null;
};

export type ExtractionCache = BaseFields & {
  cache_key: string;
  clinic_id: string;
  patient_id: string;
  document_sha256: string;
  page_selection: number[];
  parser_version: string;
  model_version: string;
  prompt_version: string;
  schema_version: string;
  provider: string;
  payload: ExtractionPayload;
  provider_metadata: ProviderMetadata | Record<string, never>;
  hit_count: number;
};

const documentSchema = new Schema<DocumentRecord>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    storage_key: { type: String, required: true },
    filename: { type: String, required: true },
    mime_type: { type: String, required: true },
    byte_size: { type: Number, required: true },
    sha256: { type: String, required: true, index: true },
    page_count: { type: Number, default: null },
    extracted_text: { type: String, default: '' },
    page_texts: { type: [String], default: [] },
    parser_version: { type: String, default: null },
    is_synthetic: { type: Boolean, default: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'UPLOADED' },
    error_code: { type: String, default: null },
    uploaded_by: { type: String, default: null },
  },
  baseOptions,
);

const extractionSchema = new Schema<Extraction>(
  {
    ...uuidId,
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true, index: true },
    document_id: { type: String, required: true, index: true },
    schema_version: { type: String, required: true },
    prompt_version: { type: String, required: true },
    parser_version: { type: String, required: true },
    provider: { type: String, required: true },
    provider_model: { type: String, required: true },
    model_revision: { type: String, default: null },
    page_selection: { type: [Number], default: [] },
    chunk_count: { type: Number, default: 1 },
    is_recorded_demo: { type: Boolean, default: false },
    status: { type: String, enum: EXTRACTION_STATUSES, default: 'PENDING' },
    error_code: { type: String, default: null },
    error_message: { type: String, default: null },
    provider_metadata: { type: Object, default: {} },
    cache_hit: { type: Boolean, default: false },
    repair_attempted: { type: Boolean, default: false },
    candidates: { type: [Object], default: [] },
    warnings: { type: [String], default: [] },
    confirmed_at: { type: Date, default: null },
    confirmed_by: { type: String, default: null },
    resulting_profile_revision_id: { type: String, default: null },
    created_by: { type: String, default: null },
  },
  baseOptions,
);

/**
 * Supplement 9: identical extractions must not burn the free quota twice.
 * The key deliberately includes clinic_id and patient_id so a cache entry can
 * never cross a clinic boundary (AI-06).
 */
const extractionCacheSchema = new Schema<ExtractionCache>(
  {
    ...uuidId,
    cache_key: { type: String, required: true, unique: true },
    clinic_id: { type: String, required: true, index: true },
    patient_id: { type: String, required: true },
    document_sha256: { type: String, required: true },
    page_selection: { type: [Number], default: [] },
    parser_version: { type: String, required: true },
    model_version: { type: String, required: true },
    prompt_version: { type: String, required: true },
    schema_version: { type: String, required: true },
    provider: { type: String, required: true },
    payload: { type: Object, required: true },
    provider_metadata: { type: Object, default: {} },
    hit_count: { type: Number, default: 0 },
  },
  baseOptions,
);

export const DocumentModel = model<DocumentRecord>('Document', documentSchema);
export const ExtractionModel = model<Extraction>('Extraction', extractionSchema);
export const ExtractionCacheModel = model<ExtractionCache>('ExtractionCache', extractionCacheSchema);
