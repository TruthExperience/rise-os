// setup-capabilities.ts — single source of truth for which setup parameters a
// car class actually exposes on the in-game setup screen.
//
// The UDP CarSetupData struct carries fields the setup screen doesn't offer,
// so serving every seeded range row put impossible sliders in the submit form
// and impossible entries in generated setups:
//   - ballast: F1 23, F1 24 and F1 25 cars (including the F1 25 2026 Season
//     Pack) don't expose it (a captured setup carries only wings,
//     differential, geometry, suspension, brakes and tyre pressures), and F2
//     runs a spec chassis with a fixed weight distribution, so no F1 or F2
//     class exposes it. The 0-100% row is part of the blanket seed every
//     class received.
//   - engine_braking: only the 2026 Season Pack's 2026 F1 cars have it (a
//     50% baseline in every fast setup). F1 25's 2025 cars and the F2 cars
//     have no such setting, and F1 2023 predates the field entirely (f24.ts
//     records engineBraking as new in the F1 24 packet). F1_2026 keeps it,
//     but still has no ballast setting.
//
// Both fetchParamRanges (which ranges the setup engine/submit form serve) and
// the telemetry ingest route (which captured fields may be written as
// setup_values) read this map, so the two paths cannot disagree.
const UNSUPPORTED_PARAMS_BY_CAR_CLASS: Record<string, readonly string[]> = {
  // F1 23 has neither setting: engine braking arrived in F1 24, and ballast
  // is only a UDP field there, not a setup-screen slider.
  F1_2023: ["ballast", "engine_braking"],
  // F1 2024 keeps engine braking (the setting arrived in F1 24, see f24.ts)
  // but has no ballast setting either. Ballast is not seeded for the class;
  // the entry guards against a future blanket seed re-adding it.
  F1_2024: ["ballast"],
  F1_2025: ["ballast", "engine_braking"],
  // The 2026 Season Pack adds engine braking to the F1 25 setup screen but
  // still has no ballast slider.
  F1_2026: ["ballast"],
  // Each game's F1 World Car reuses that game's own F1 setup screen: F1 23
  // has no engine braking, F1 24 has engine braking but no ballast, and F1 25
  // has neither. Ranges are copied from the matching F1 class. F1_WORLD is
  // the F1 25 class and stays on its original code (league tiers reference it).
  // F1_WORLD_F126 is the 2026 Season Pack's World Car and follows F1_2026:
  // engine braking present, no ballast slider.
  F1_WORLD: ["ballast", "engine_braking"],
  F1_WORLD_F123: ["ballast", "engine_braking"],
  F1_WORLD_F124: ["ballast"],
  F1_WORLD_F126: ["ballast"],
  // F2 runs the spec chassis in every game, and engine braking is missing
  // from the F2 setup screen in F1 24 (simracingsetup's F1 24 F2 guide).
  F2_2023_F123: ["ballast", "engine_braking"],
  F2_2023_F124: ["ballast", "engine_braking"],
  F2_2024_F124: ["ballast", "engine_braking"],
  F2_2024_F125: ["ballast", "engine_braking"],
  F2_2025: ["ballast", "engine_braking"],
  F2_2026: ["ballast", "engine_braking"],
};

const NO_EXCLUSIONS: readonly string[] = [];

/**
 * Setup param keys the given car class does not expose. An unknown or missing
 * code has no exclusions (callers keep every range row rather than failing a
 * request over a class-level exclusion).
 */
export function getUnsupportedSetupParams(
  carClassCode: string | null | undefined
): readonly string[] {
  if (!carClassCode) return NO_EXCLUSIONS;
  return UNSUPPORTED_PARAMS_BY_CAR_CLASS[carClassCode] ?? NO_EXCLUSIONS;
}

/** Whether the car class exposes a single setup parameter on its setup screen. */
export function isSetupParamSupported(
  carClassCode: string | null | undefined,
  paramKey: string
): boolean {
  return !getUnsupportedSetupParams(carClassCode).includes(paramKey);
}
