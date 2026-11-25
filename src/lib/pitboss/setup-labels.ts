// src/lib/pitboss/setup-labels.ts
//
// In-game setup parameter names shared by the setup generator and the
// feedback adjustment table. Keys not overridden are title-cased from their
// param_key (front_wing_aero -> Front Wing Aero).

const SETUP_PARAM_LABEL_OVERRIDES: Record<string, string> = {
  diff_adjustment_on_throttle: 'Differential Adjustment On Throttle',
  diff_adjustment_off_throttle: 'Differential Adjustment Off Throttle',
  front_arb: 'Front Anti-Roll Bar',
  rear_arb: 'Rear Anti-Roll Bar',
  front_toe_out: 'Front Toe-Out',
  rear_toe_in: 'Rear Toe-In',
}

export function setupParamLabel(key: string): string {
  return (
    SETUP_PARAM_LABEL_OVERRIDES[key] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  )
}
