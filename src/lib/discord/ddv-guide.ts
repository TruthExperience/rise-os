// src/lib/discord/ddv-guide.ts
//
// The pinnable, plain-English DDV explainer behind `/ddv guide`.
//
// Deliberately dependency-free (it takes the money formatter and every number
// as parameters) so: the same text can be length-checked without booting the
// bot, and every figure it quotes comes from the league's own
// league_financial_config rather than being hardcoded here.
//
// Discord rejects messages over 2000 characters, so the text is kept short on
// purpose — there is a length check in the handler's tests/verification.

export type DdvGuideParams = {
  money: (n: number) => string;
  /** Currency name and symbol, e.g. "W11 pounds (£)". */
  currencyName: string;
  /** Contract floor as a fraction of DDV (1 = 100%). */
  floorPct: number;
  /** Contract ceiling as a fraction of DDV (1.1 = 110%). */
  ceilingPct: number;
  softCap: number;
  apron: number;
  gainCap: number;
  lossCap: number;
  /** Attendance costs, as fractions (0.05 = 5%). */
  noshowPct: number;
  declinePct: number;
  penaltyMin: number;
  penaltyMax: number;
  attendanceCap: number;
  perPoint: number;
  perQuali: number;
  perSprint: number;
  headToHead: number;
  cleanWeekend: number;
  penaltyPoint: number;
};

// One decimal only when it matters: 5%, 100%, 110% stay whole numbers but
// 1.5% must not round to a flat 2%.
function pct(fraction: number): string {
  const value = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function buildDdvGuide(p: DdvGuideParams): string {
  return [
    "**DDV — the short version**",
    "",
    "Your DDV (Dynamic Driver Value) is what the league reckons you're worth right now. Every finalized round moves it, and every contract has to sit inside it.",
    "",
    "**What adds DDV**",
    `• Race result — the biggest mover (≈ ${p.money(p.perPoint)} per point)`,
    `• Qualifying — out-qualifying your team-mate (≈ ${p.money(p.perQuali)} a place)`,
    `• Sprint points (≈ ${p.money(p.perSprint)} each)`,
    `• Winning the head-to-head (≈ ${p.money(p.headToHead)} a round)`,
    `• Turning up every week — streak bonus up to ${p.money(p.attendanceCap)}`,
    `• A clean weekend, no steward penalties (≈ ${p.money(p.cleanWeekend)})`,
    "• Pace rating (Elo) gains",
    "",
    "**What costs DDV**",
    `• Missing a race — ${pct(p.noshowPct)} of your DDV, plus a ${p.money(p.penaltyMin)}–${p.money(p.penaltyMax)} fine`,
    `• Declining a race — ${pct(p.declinePct)}, multiplied if you keep doing it`,
    `• Penalty points from stewards (≈ −${p.money(p.penaltyPoint)} each)`,
    `• Losing the head-to-head (≈ −${p.money(p.headToHead)})`,
    "• Not racing — your DDV decays every off-season you sit out",
    "",
    "**The weekend cap**",
    `One weekend moves your DDV by at most **+${p.money(p.gainCap)}** or **−${p.money(p.lossCap)}**. No overnight superstar, and no losing a career in one bad race.`,
    "",
    "**Contract floor and ceiling**",
    `• Floor: **${pct(p.floorPct)} of DDV** — you can't be signed below your value`,
    `• Ceiling: **${pct(p.ceilingPct)} of DDV** — you can't be signed above it`,
    `• Team limits: ${p.money(p.softCap)} soft cap, ${p.money(p.apron)} hard apron. A deal that pushes payroll past the apron is refused.`,
    "• Sign with no value stated and the deal is priced at the floor.",
    "",
    `All figures in ${p.currencyName}. Look yourself up: /ddv view · /ddv team · /ddv leaderboard`,
  ].join("\n");
}
