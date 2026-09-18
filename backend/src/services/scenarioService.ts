import { loadClinicalContent, type ClinicalContent, type MedicationEntry } from '../content/loader.js';
import { ApiError, type FieldError } from '../middleware/error.js';
import type { ProfileRevision, RegimenItem, ScenarioAction } from '../models/index.js';

/**
 * Applies the doctor's add/modify/stop actions to the confirmed regimen and
 * returns the final plan the rule engine will evaluate (UF-02.4, FR-08).
 * The frontend never computes this.
 */
export function buildFinalRegimen(revision: ProfileRevision, actions: ScenarioAction[]): RegimenItem[] {
  const content = loadClinicalContent();

  const items = new Map<string, RegimenItem>();
  for (const med of revision.medications_snapshot) {
    if (med.status !== 'active') continue;
    const entry = content.medications.find((m) => m.ingredient_code === med.ingredient_code);
    items.set(med.statement_id, {
      ingredient_code: med.ingredient_code,
      ingredient_name: med.ingredient_name,
      classes: entry?.classes ?? [],
      dose_value: med.dose_value,
      dose_unit: med.dose_unit,
      route: med.route,
      frequency_per_day: med.frequency_per_day,
      duration_days: null,
      origin: 'existing',
      medication_statement_id: med.statement_id,
      supported_checks: entry?.supported_checks ?? [],
      unsupported_checks: entry?.unsupported_checks ?? [],
      in_catalog: entry != null,
    });
  }

  let addCounter = 0;
  for (const action of actions) {
    if (action.type === 'stop') {
      if (!items.delete(action.medication_statement_id)) {
        throw ApiError.badRequest(
          'UNKNOWN_MEDICATION_STATEMENT',
          'To‘xtatiladigan dori joriy rejada topilmadi.',
        );
      }
      continue;
    }

    if (action.type === 'modify') {
      const existing = items.get(action.medication_statement_id);
      if (!existing) {
        throw ApiError.badRequest(
          'UNKNOWN_MEDICATION_STATEMENT',
          'O‘zgartiriladigan dori joriy rejada topilmadi.',
        );
      }
      items.set(action.medication_statement_id, {
        ...existing,
        dose_value: action.dose_value,
        dose_unit: action.dose_unit,
        route: action.route,
        frequency_per_day: action.frequency_per_day,
        duration_days: action.duration_days,
        origin: 'modified',
      });
      continue;
    }

    const entry = content.medications.find((m) => m.ingredient_code === action.ingredient_code);
    if (!entry) {
      // UI-05: a medication outside the catalogue is never approximately mapped.
      throw ApiError.badRequest(
        'MEDICATION_NOT_IN_CATALOG',
        `Faol modda katalogda yo‘q: ${action.ingredient_code}. Taxminiy moslashtirish bajarilmaydi.`,
      );
    }

    addCounter += 1;
    items.set(`added:${action.ingredient_code}:${addCounter}`, {
      ingredient_code: entry.ingredient_code,
      ingredient_name: entry.ingredient_name,
      classes: entry.classes,
      dose_value: action.dose_value,
      dose_unit: action.dose_unit,
      route: action.route,
      frequency_per_day: action.frequency_per_day,
      duration_days: action.duration_days,
      origin: 'added',
      medication_statement_id: null,
      supported_checks: entry.supported_checks,
      unsupported_checks: entry.unsupported_checks,
      in_catalog: true,
    });
  }

  // Deterministic order so the same inputs hash to the same analysis (FR-09).
  return [...items.values()].sort((a, b) =>
    a.ingredient_code === b.ingredient_code
      ? (a.medication_statement_id ?? '').localeCompare(b.medication_statement_id ?? '')
      : a.ingredient_code.localeCompare(b.ingredient_code),
  );
}

/**
 * Spec 12.1: `tablet` is only accepted for a catalogue product whose form and
 * strength are known; otherwise the active-ingredient amount and unit are
 * required.
 */
export function validateActionDosing(actions: ScenarioAction[], content: ClinicalContent = loadClinicalContent()): void {
  const fieldErrors: FieldError[] = [];

  actions.forEach((action, index) => {
    if (action.type === 'stop') return;
    const unit = action.dose_unit;
    if (unit == null) return;

    const entry =
      action.type === 'add' ? content.medications.find((m) => m.ingredient_code === action.ingredient_code) : undefined;

    if (unit === 'tablet') {
      if (!entry || entry.products.length === 0) {
        fieldErrors.push({
          field: `actions.${index}.dose_unit`,
          message:
            'Bu dori uchun katalogda kuchi va shakli aniqlangan mahsulot yo‘q — faol modda miqdori va birligini kiriting.',
        });
      }
      return;
    }

    if (entry && !entry.allowed_units.includes(unit)) {
      fieldErrors.push({
        field: `actions.${index}.dose_unit`,
        message: `"${unit}" birligi bu dori uchun ruxsat etilmagan. Ruxsat etilganlar: ${entry.allowed_units.join(', ')}.`,
      });
    }
    if (entry && action.route && !entry.routes.includes(action.route)) {
      fieldErrors.push({
        field: `actions.${index}.route`,
        message: `"${action.route}" yo‘li bu dori uchun ruxsat etilmagan. Ruxsat etilganlar: ${entry.routes.join(', ')}.`,
      });
    }
  });

  if (fieldErrors.length > 0) {
    throw ApiError.unprocessable('INVALID_DOSING', 'Doza yoki birlik katalog talablariga mos emas.', fieldErrors);
  }
}

export function catalogEntry(content: ClinicalContent, code: string): MedicationEntry | undefined {
  return content.medications.find((m) => m.ingredient_code === code);
}
