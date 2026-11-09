function matches(when, change) {
  return Object.entries(when).every(([key, expected]) =>
    Array.isArray(expected) ? expected.includes(change[key]) : change[key] === expected,
  );
}

export function findRule(change, policy) {
  return policy.rules.find((rule) => matches(rule.when, change)) ?? null;
}

// Décision pure : aucune écriture, tout le contexte est passé en paramètre.
// Le gel calendaire et la santé s'appliquent même à un changement approuvé.
export function decide(change, { policy, state, healthy, schedule, autoCountToday }) {
  const blocked = state.blocked[change.id];
  if (blocked) return { outcome: 'blocked', reasons: [blocked.reason], rule: null };
  if (state.paused) return { outcome: 'deferred', reasons: [`agent en pause : ${state.paused.reason}`], rule: null };

  const rule = findRule(change, policy);
  const action = rule?.action ?? policy.default;
  const ruleName = rule?.name ?? 'règle par défaut';
  const approved = state.approved.includes(change.id);

  if (action === 'deny') return { outcome: 'denied', reasons: [`interdit par : ${ruleName}`], rule };
  // L'analyse IA peut exiger une validation humaine, jamais en dispenser.
  if (change.requiresReview && !approved) return { outcome: 'awaiting-approval', reasons: [change.requiresReview], rule };
  if (action === 'approval' && !approved) {
    return { outcome: 'awaiting-approval', reasons: [`validation requise par : ${ruleName}`], rule };
  }

  if (!healthy) return { outcome: 'deferred', reasons: ['site instable'], rule };
  if (schedule.frozen) return { outcome: 'deferred', reasons: [schedule.reason], rule };

  if (approved) return { outcome: 'apply', reasons: ['approuvé manuellement'], rule };

  if (!schedule.allowed && !rule?.bypassWindow) return { outcome: 'deferred', reasons: [schedule.reason], rule };
  if (autoCountToday >= policy.maxAutoPerDay) {
    return { outcome: 'deferred', reasons: [`quota de ${policy.maxAutoPerDay} mises à jour par 24 h atteint`], rule };
  }
  return { outcome: 'apply', reasons: [`autorisé par : ${ruleName}`], rule };
}
