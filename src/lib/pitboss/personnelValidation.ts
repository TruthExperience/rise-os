// src/lib/pitboss/personnelValidation.ts

// Shared by POST here and PATCH in [id]: size and type limits for the free-form
// parts of an entry. Returns an error message, or null if the values are fine.
export function checkPersonnelFields(b: Record<string, any>): string | null {
  if ('full_name' in b && (typeof b.full_name !== 'string' || !b.full_name.trim() || b.full_name.length > 120)) {
    return 'full_name must be text up to 120 characters'
  }
  for (const k of ['team_name', 'position'] as const) {
    if (k in b && b[k] != null && (typeof b[k] !== 'string' || b[k].length > 120)) {
      return `${k} must be text up to 120 characters`
    }
  }
  if ('notes' in b && b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 2000)) {
    return 'notes must be text up to 2000 characters'
  }
  if ('driver_number' in b && b.driver_number != null &&
      (typeof b.driver_number !== 'number' || !Number.isInteger(b.driver_number) || b.driver_number < 0 || b.driver_number > 999)) {
    return 'driver_number must be a whole number from 0 to 999'
  }
  if ('is_active' in b && typeof b.is_active !== 'boolean') {
    return 'is_active must be true or false'
  }
  if ('attributes' in b && b.attributes != null) {
    const a = b.attributes
    if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length > 60) {
      return 'attributes must be an object with at most 60 entries'
    }
    for (const [k, v] of Object.entries(a)) {
      if (k.length > 60 || !(typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.length <= 200)) {
        return 'attributes values must be numbers or short text'
      }
    }
  }
  return null
}
