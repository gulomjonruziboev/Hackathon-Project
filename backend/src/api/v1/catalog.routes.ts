import { Router } from 'express';
import { env } from '../../config/env.js';
import { loadClinicalContent, matchMedicationsByName } from '../../content/loader.js';
import { EXTRACTION_SCHEMA_VERSION, PARSER_VERSION, PROMPT_VERSION } from '../../llm/extractionSchema.js';
import { extractionGate } from '../../llm/LLMAdapter.js';
import { requireSession } from '../../middleware/auth.js';
import { dbReady } from '../../db/connect.js';

export const catalogRouter: Router = Router();

/** FR-07 / spec 10.1: the UI must be able to show which checks each drug supports. */
catalogRouter.get('/medications', requireSession, (req, res, next) => {
  try {
    const content = loadClinicalContent();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    // Trade-name lookup returns every exact match so the doctor resolves
    // ambiguity themselves; nothing is approximately mapped (UI-05).
    const exactMatches = q ? matchMedicationsByName(content, q) : [];
    const items = q
      ? content.medications.filter(
          (m) =>
            m.ingredient_name.toLowerCase().includes(q.toLowerCase()) ||
            m.ingredient_code.toLowerCase().includes(q.toLowerCase()) ||
            m.aliases.some((a) => a.toLowerCase().includes(q.toLowerCase())),
        )
      : content.medications;

    res.json({
      catalog_version: content.catalogVersion,
      exact_match_count: exactMatches.length,
      exact_matches: exactMatches.map((m) => m.ingredient_code),
      items: items.map((m) => ({
        ingredient_code: m.ingredient_code,
        ingredient_name: m.ingredient_name,
        aliases: m.aliases,
        classes: m.classes,
        allowed_forms: m.allowed_forms,
        allowed_units: m.allowed_units,
        routes: m.routes,
        products: m.products,
        supported_checks: m.supported_checks,
        unsupported_checks: m.unsupported_checks,
      })),
      note: 'Katalogda dori borligi uning barcha xavflari tekshirilishini anglatmaydi.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /system/capabilities — which modules are on, which ruleset is loaded and
 * how much of it is clinically reviewed. No secrets, no API keys.
 */
catalogRouter.get('/system/capabilities', requireSession, (_req, res, next) => {
  try {
    const content = loadClinicalContent();
    const config = env();
    const reviewed = content.rules.filter((r) => r.review_status === 'reviewed' && r.enabled);
    const illustrative = content.rules.filter((r) => r.review_status === 'illustrative' && r.enabled);

    res.json({
      app_env: config.APP_ENV,
      is_synthetic_environment: true,
      ruleset: {
        version: content.rulesetVersion,
        checksum: content.rulesetChecksum,
        release_status: content.releaseStatus,
        reviewed_at: content.reviewedAt,
        reviewed_by: content.reviewedBy,
        enabled_rule_count: content.rules.filter((r) => r.enabled).length,
        reviewed_rule_count: reviewed.length,
        illustrative_rule_count: illustrative.length,
      },
      catalog: { version: content.catalogVersion, medication_count: content.medications.length },
      evidence: {
        version: content.evidenceVersion,
        pending_review_count: content.evidence.filter((e) => e.verification_status === 'pending_review').length,
      },
      dimensions: {
        supported: content.dimensionsSupported,
        unsupported: content.dimensionsUnsupported,
      },
      ai: {
        provider: config.LLM_PROVIDER,
        model_id: config.LLM_PROVIDER === 'ollama' ? config.OLLAMA_MODEL : config.LLM_MODEL,
        prompt_version: PROMPT_VERSION,
        schema_version: EXTRACTION_SCHEMA_VERSION,
        parser_version: PARSER_VERSION,
        timeout_seconds: config.LLM_TIMEOUT_SECONDS,
        max_concurrency: config.LLM_MAX_CONCURRENCY,
        in_flight: extractionGate().inFlight,
        local_fallback_enabled: config.LOCAL_FALLBACK_ENABLED,
        allow_paid_providers: config.ALLOW_PAID_PROVIDERS,
        allow_real_patient_data: config.ALLOW_REAL_PATIENT_DATA,
        configured: config.LLM_PROVIDER === 'groq' ? config.GROQ_API_KEY !== '' : true,
      },
      modules: {
        kfre: { enabled: config.ENABLE_KFRE, status: config.ENABLE_KFRE ? 'enabled' : 'Hali yoqilmagan' },
        ocr: { enabled: config.ENABLE_OCR, status: config.ENABLE_OCR ? 'enabled' : 'Hali yoqilmagan' },
        rag: { enabled: config.ENABLE_RAG, status: config.ENABLE_RAG ? 'enabled' : 'Hali yoqilmagan' },
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Public health probe. Never returns configuration values or secrets. */
catalogRouter.get('/health', (_req, res) => {
  res.json({ status: dbReady() ? 'ok' : 'degraded', db: dbReady() ? 'up' : 'down' });
});
