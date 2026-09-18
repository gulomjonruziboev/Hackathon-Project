/**
 * Spec 8.2: conversion happens ONLY from this fixed table. The LLM never
 * produces a formula, and a missing value is never computed to fill a gap.
 * A code/unit pair that is not listed here stays unconverted and any rule
 * depending on it becomes NOT_EVALUABLE.
 */

export type ObservationCode =
  | 'EGFR'
  | 'CREATININE'
  | 'POTASSIUM'
  | 'SODIUM'
  | 'HBA1C'
  | 'UACR'
  | 'GLUCOSE_FASTING'
  | 'WEIGHT'
  | 'HEIGHT'
  | 'SYSTOLIC_BP'
  | 'DIASTOLIC_BP';

export const OBSERVATION_CODES: ObservationCode[] = [
  'EGFR',
  'CREATININE',
  'POTASSIUM',
  'SODIUM',
  'HBA1C',
  'UACR',
  'GLUCOSE_FASTING',
  'WEIGHT',
  'HEIGHT',
  'SYSTOLIC_BP',
  'DIASTOLIC_BP',
];

export const CANONICAL_UNIT: Record<ObservationCode, string> = {
  EGFR: 'mL/min/1.73m2',
  CREATININE: 'mg/dL',
  POTASSIUM: 'mmol/L',
  SODIUM: 'mmol/L',
  HBA1C: '%',
  UACR: 'mg/g',
  GLUCOSE_FASTING: 'mmol/L',
  WEIGHT: 'kg',
  HEIGHT: 'cm',
  SYSTOLIC_BP: 'mmHg',
  DIASTOLIC_BP: 'mmHg',
};

type Conversion = { factor: number; offset?: number };

/** key: `${CODE}|${normalized source unit}` -> conversion into CANONICAL_UNIT[CODE] */
const TABLE: Record<string, Conversion> = {
  'EGFR|ml/min/1.73m2': { factor: 1 },
  'EGFR|ml/min/1,73m2': { factor: 1 },
  'EGFR|ml/min': { factor: 1 },
  'CREATININE|mg/dl': { factor: 1 },
  'CREATININE|umol/l': { factor: 1 / 88.4 },
  'CREATININE|mkmol/l': { factor: 1 / 88.4 },
  'POTASSIUM|mmol/l': { factor: 1 },
  'POTASSIUM|meq/l': { factor: 1 },
  'SODIUM|mmol/l': { factor: 1 },
  'SODIUM|meq/l': { factor: 1 },
  'HBA1C|%': { factor: 1 },
  'HBA1C|mmol/mol': { factor: 0.0915, offset: 2.15 },
  'UACR|mg/g': { factor: 1 },
  'UACR|mg/mmol': { factor: 8.8402 },
  'GLUCOSE_FASTING|mmol/l': { factor: 1 },
  'GLUCOSE_FASTING|mg/dl': { factor: 1 / 18.0182 },
  'WEIGHT|kg': { factor: 1 },
  'HEIGHT|cm': { factor: 1 },
  'HEIGHT|m': { factor: 100 },
  'SYSTOLIC_BP|mmhg': { factor: 1 },
  'DIASTOLIC_BP|mmhg': { factor: 1 },
};

export function normalizeUnitToken(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/µ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/\s+/g, '');
}

export type UnitConversion =
  | { ok: true; value: number; unit: string; converted: boolean }
  | { ok: false; reason: 'unknown_code' | 'unknown_unit' | 'missing_unit' };

export function toCanonical(code: string, value: number, unit: string | null | undefined): UnitConversion {
  if (!OBSERVATION_CODES.includes(code as ObservationCode)) return { ok: false, reason: 'unknown_code' };
  const canonical = CANONICAL_UNIT[code as ObservationCode];
  if (unit == null || unit.trim() === '') return { ok: false, reason: 'missing_unit' };
  const key = `${code}|${normalizeUnitToken(unit)}`;
  const conv = TABLE[key];
  if (!conv) return { ok: false, reason: 'unknown_unit' };
  const out = value * conv.factor + (conv.offset ?? 0);
  return {
    ok: true,
    value: Math.round(out * 1e6) / 1e6,
    unit: canonical,
    converted: normalizeUnitToken(unit) !== normalizeUnitToken(canonical),
  };
}

export function isKnownObservationCode(code: string): code is ObservationCode {
  return OBSERVATION_CODES.includes(code as ObservationCode);
}
