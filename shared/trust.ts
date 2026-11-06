// The Etsy approval ramp — pure, shared by the server (which applies the
// events) and the client (which shows the meter). Publishing starts in
// "approval mode": every listing waits for a human click. After
// `threshold` consecutive approvals the shop goes autonomous and listings
// publish straight away; a revert (refund / bad review) or the owner's
// revoke drops it back.
// No IO — persisted into state.json by the factory.

export interface EtsyTrust {
  /// consecutive approved listings (edited approvals reset this too)
  streak: number;
  /// true once the streak hit the threshold — listings publish unapproved
  autonomous: boolean;
  log: {
    at: number;
    sku?: string;
    event: 'approved' | 'edited' | 'rejected' | 'promoted' | 'revert' | 'revoked';
    note?: string;
  }[];
}

export const emptyTrust = (): EtsyTrust => ({ streak: 0, autonomous: false, log: [] });

const LOG_CAP = 100;

/// Apply one trust event and return the updated trust (mutates a copy —
/// callers keep the original reference style, we return the same object).
export function applyTrustEvent(
  trust: EtsyTrust,
  ev: { kind: 'approved' | 'edited' | 'rejected' | 'revert' | 'revoked'; sku?: string; note?: string; at: number },
  threshold: number,
): EtsyTrust {
  const t: EtsyTrust = { streak: trust.streak, autonomous: trust.autonomous, log: [...trust.log] };
  const push = (event: EtsyTrust['log'][number]['event'], note?: string): void => {
    t.log.push({ at: ev.at, sku: ev.sku, event, ...(note ? { note } : {}) });
    if (t.log.length > LOG_CAP) t.log.splice(0, t.log.length - LOG_CAP);
  };
  switch (ev.kind) {
    case 'approved':
      t.streak += 1;
      push('approved', ev.note);
      // the threshold-th approval promotes, not the one before it
      if (!t.autonomous && t.streak >= threshold) {
        t.autonomous = true;
        push('promoted', `trust threshold ${threshold} reached — autonomous publishing on`);
      }
      break;
    case 'edited':
      // an approved listing the human had to fix — still ships, but the
      // pipeline clearly isn't trusted yet
      t.streak = 0;
      push('edited', ev.note);
      break;
    case 'rejected':
      t.streak = 0;
      push('rejected', ev.note);
      break;
    case 'revert':
      // refund / bad review (wired in a later step) — autonomy revoked
      t.autonomous = false;
      t.streak = 0;
      push('revert', ev.note);
      break;
    case 'revoked':
      // the owner flipped autonomy off by hand
      t.autonomous = false;
      t.streak = 0;
      push('revoked', ev.note);
      break;
  }
  return t;
}

/// Has this sku already earned a trust event (approved or edited)? Trust
/// counts ONCE per sku — a re-approval after a failed publish must not
/// pad the streak.
export function hasApprovalEvent(trust: EtsyTrust, sku: string): boolean {
  return trust.log.some((e) => e.sku === sku && (e.event === 'approved' || e.event === 'edited'));
}
