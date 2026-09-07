// =======================================================================
// PATCH for src/lib/pitboss/telemetry-coach.ts
// =======================================================================
//
// PROBLEM: ISSUE_MERGE_DIST_METERS (3m) merges same-kind issues that are
// close together in DISTANCE. But issues are emitted once per FRAME, and
// frame-to-frame distance scales with speed (and with capture rate, which
// this same file documents elsewhere as bursty/variable — see
// SOURCE_GAP_UNRELIABLE_SECONDS's comment). At typical corner-exit/
// straight-line speeds, consecutive frames are commonly 5-8m apart —
// already past the 3m threshold — so a single sustained over-rev or
// sustained snap-correction run fails to merge and is reported as N
// separate issues, one per frame, exactly the failure this mechanism was
// built to prevent (see DetectedIssue.endDist's doc comment).
//
// FIX: merge by FRAME ADJACENCY instead of raw distance. Frame adjacency
// is invariant to speed and capture-rate variance — "the last frame that
// produced a same-kind issue was N frames ago" is a stable signal in a
// way that "was N meters ago" is not. Track frame index alongside dist
// while detecting, merge based on a small frame-index gap, then drop the
// index from the returned objects (DetectedIssue's public shape is
// unchanged).
//
// Replace the existing ISSUE_MERGE_DIST_METERS constant + mergeAdjacentIssues
// function + detectIssues' push sites with the below.

// DELETE:
//   const ISSUE_MERGE_DIST_METERS = 3;
//   function mergeAdjacentIssues(issues: DetectedIssue[]): DetectedIssue[] { ... }
//
// (mergeAdjacentIssues is no longer a separate post-pass — merging now
// happens inline in detectIssues, since it needs the frame index that
// isn't part of the public DetectedIssue shape.)

// ADD, in place of ISSUE_MERGE_DIST_METERS:

// Consecutive same-kind issues within this many FRAMES (not meters) of
// each other are one sustained condition, not N separate events. Frame
// adjacency is used instead of a distance threshold because frame-to-
// frame distance scales with speed and capture rate — a fixed-meters
// threshold that looked reasonable at low speed silently stopped merging
// at highway speed / lower-Hz captures, which is exactly how this bug
// shipped (see the corner-1 wall of one-per-frame "Held N RPM" issues in
// the 2026-XX-XX bug report: gaps of 5-7m between consecutive flagged
// frames, all past the old 3m threshold). A small frame-index gap (2)
// tolerates one skipped/filtered frame without breaking the merge, same
// as the old distance threshold intended, but doesn't depend on speed.
const ISSUE_MERGE_FRAME_GAP = 2;

// REPLACE the whole detectIssues function body with this version — same
// signature and return type, merging now happens inline during the frame
// loop instead of as a separate post-pass over the finished array.
export function detectIssues(
  frames: TelemetryFrame[],
  redlineRpm: number = DEFAULT_REDLINE_RPM,
  speedUnit: SpeedUnit = 'kph'
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const unitLabel = speedUnitLabel(speedUnit);

  // Tracks, per issue kind, the frame index at which that kind was last
  // emitted/extended and the index into `issues` of that entry — so a new
  // detection can extend the existing entry (bump endDist, escalate
  // severity) instead of always pushing a new one.
  const lastFrameIndexByKind = new Map<DetectedIssue['kind'], number>();
  const lastIssueIndexByKind = new Map<DetectedIssue['kind'], number>();

  function emit(kind: DetectedIssue['kind'], frameIdx: number, dist: number, severity: 'minor' | 'major', note: string) {
    const lastFrameIdx = lastFrameIndexByKind.get(kind);
    const lastIssueIdx = lastIssueIndexByKind.get(kind);
    if (
      lastFrameIdx !== undefined &&
      lastIssueIdx !== undefined &&
      frameIdx - lastFrameIdx <= ISSUE_MERGE_FRAME_GAP
    ) {
      // Extend the existing sustained-condition entry rather than
      // starting a new one.
      const existing = issues[lastIssueIdx];
      existing.endDist = dist;
      if (severity === 'major') existing.severity = 'major';
    } else {
      issues.push({ kind, dist, severity, note });
      lastIssueIndexByKind.set(kind, issues.length - 1);
    }
    lastFrameIndexByKind.set(kind, frameIdx);
  }

  for (let i = 2; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];

    if (curr.brake > 0.8 && prev.brake > 0.8) {
      const gDrop = prev.gLon - curr.gLon;
      if (gDrop > 0.4 && curr.speed < prev.speed) {
        emit(
          'lockup',
          i,
          curr.dist,
          gDrop > 0.7 ? 'major' : 'minor',
          `Possible lockup — braking g dropped ${gDrop.toFixed(2)}g while still on the brakes.`
        );
      }
    }

    const steerDelta = curr.steer - prev.steer;
    if (Math.abs(steerDelta) > 25 && curr.speed > 30 && Math.sign(steerDelta) !== Math.sign(prev.steer - frames[i - 2].steer)) {
      const displaySpeed = convertSpeed(curr.speed, speedUnit);
      emit(
        'snap_correction',
        i,
        curr.dist,
        Math.abs(steerDelta) > 45 ? 'major' : 'minor',
        `Sharp steering correction (${steerDelta.toFixed(0)}° in one frame) at ${displaySpeed.toFixed(0)} ${unitLabel} — possible rear-end slide.`
      );
    }

    if (curr.rpm > 0 && prev.gear === curr.gear && curr.rpm > 0.98 * (prev.rpm || curr.rpm) && curr.rpm > redlineRpm) {
      emit(
        'engine_over_rev',
        i,
        curr.dist,
        'minor',
        `Held ${curr.rpm} RPM in gear ${curr.gear} — check for a missed upshift.`
      );
    }
  }

  return issues;
}
