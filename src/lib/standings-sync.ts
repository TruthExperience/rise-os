// FILE: src/lib/standings-sync.ts   (new file)
// Tells every open standings view in this browser that results changed.
export const RESULTS_CHANNEL = "pitboss-results";

export function announceResultsChanged(leagueId?: string) {
  try {
    const bc = new BroadcastChannel(RESULTS_CHANNEL);
    bc.postMessage({ leagueId, at: Date.now() });
    bc.close();
  } catch {
    /* BroadcastChannel unsupported — polling still picks it up */
  }
}
