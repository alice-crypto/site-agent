const POLL_MS = 4000;

const OUTCOMES = {
  apply: ['À appliquer', 'good'],
  'awaiting-approval': ['Validation requise', 'warn'],
  deferred: ['Reporté', ''],
  denied: ['Interdit', 'bad'],
  blocked: ['Bloqué', 'bad'],
};
const RESULTS = {
  deployed: 'Mise à jour déployée.',
  'rolled-back': 'Échec : retour à la version précédente effectué.',
  'rollback-failed': 'Le retour arrière a échoué : intervention requise.',
  'preparation-failed': 'Abandon avant déploiement : le site en ligne n\'a pas changé.',
  'dirty-worktree': 'Annulé : le dossier contient des modifications manuelles.',
  'no-change': 'Aucun changement à appliquer.',
};
const RISKS = { low: 'faible', medium: 'moyen', high: 'élevé' };
const AUTONOMY = [
  ['now', 'Automatique, immédiatement'],
  ['auto', 'Automatique, dans les plages'],
  ['approval', 'Ma validation'],
  ['deny', 'Interdit'],
];
const DAYS = [['mon', 'Lun'], ['tue', 'Mar'], ['wed', 'Mer'], ['thu', 'Jeu'], ['fri', 'Ven'], ['sat', 'Sam'], ['sun', 'Dim']];
const COMMANDS = [['deploy', 'Déploiement'], ['test', 'Tests'], ['install', 'Installation'], ['build', 'Build'], ['restart', 'Redémarrage']];

const ROLE_LABELS = { viewer: 'Lecteur', operator: 'Opérateur', admin: 'Administrateur' };
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
const LOGIN_URL = '/comptes/connexion/';

const app = {
  user: null,
  demo: false,
  links: {},
  sites: [],
  watching: false,
  selected: null,
  tab: 'overview',
  loaded: false,
  working: new Set(),
  rendered: '',
};

// L'interface masque ce que le rôle ne permet pas, mais c'est le serveur qui fait foi.
function can(role) {
  return ROLE_RANK[app.user?.role] >= ROLE_RANK[role];
}

const $ = (id) => document.getElementById(id);

// Toutes les données passent par textContent ou des propriétés : jamais de HTML construit à partir d'une valeur.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// Django refuse toute modification qui ne renvoie pas son jeton anti-falsification (CSRF).
function csrfToken() {
  const cookie = document.cookie.split('; ').find((part) => part.startsWith('site_agent_csrf='));
  return cookie ? decodeURIComponent(cookie.slice('site_agent_csrf='.length)) : '';
}

function goToLogin() {
  location.assign(`${app.links.login ?? LOGIN_URL}?next=${encodeURIComponent(location.pathname)}`);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (method !== 'GET') headers['x-csrftoken'] = csrfToken();
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  // Session expirée : la connexion se fait sur la page de Django.
  if (response.status === 401 && !app.demo) goToLogin();
  if (!response.ok) throw new Error(payload.error ?? payload.detail ?? `Erreur ${response.status}`);
  return payload;
}

function sitePath(name, suffix = '') {
  return `/sites/${encodeURIComponent(name)}${suffix}`;
}

function toast(message, tone = '') {
  const element = h('div', { class: `toast ${tone}` }, message);
  $('toasts').append(element);
  setTimeout(() => element.remove(), tone === 'bad' ? 8000 : 4000);
}

function confirmAction({ title, text, ok, danger = false }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  $('confirm-ok').className = danger ? 'button danger' : 'button primary';
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (answer) => {
      $('confirm-ok').removeEventListener('click', accept);
      $('confirm-cancel').removeEventListener('click', refuse);
      dialog.removeEventListener('cancel', refuse);
      dialog.close();
      resolve(answer);
    };
    const accept = () => finish(true);
    const refuse = () => finish(false);
    $('confirm-ok').addEventListener('click', accept);
    $('confirm-cancel').addEventListener('click', refuse);
    dialog.addEventListener('cancel', refuse);
  });
}

// Exécute une action de site, empêche le double clic et rafraîchit l'affichage.
async function perform(key, task, successMessage) {
  if (app.working.has(key)) return;
  app.working.add(key);
  renderDetailIfOverview(true);
  try {
    const result = await task();
    const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
    if (message) toast(message, 'good');
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    app.working.delete(key);
    await refresh(true);
  }
}

function healthInfo(site) {
  if (site.invalid) return { dot: 'bad', label: 'Configuration invalide' };
  if (site.paused) return { dot: 'bad', label: 'En pause' };
  if (!site.health) return { dot: '', label: 'Vérification…' };
  return site.health.healthy ? { dot: 'good', label: 'En ligne' } : { dot: 'bad', label: 'Problème détecté' };
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
}

/* Liste des sites */
function renderSidebar() {
  $('watch-toggle').setAttribute('aria-pressed', String(app.watching));
  $('watch-label').textContent = app.watching ? 'Surveillance active' : 'Surveillance arrêtée';
  $('watch-toggle').disabled = !can('admin');
  $('watch-toggle').title = !can('admin')
    ? 'Seul un administrateur peut changer la surveillance.'
    : app.watching
      ? 'Tous les sites sont surveillés tant que cette application tourne. Cliquez pour arrêter.'
      : 'Cliquez pour surveiller tous les sites en continu.';

  // Reconstruire une liste inchangée ferait perdre le focus clavier et les clics en cours.
  const signature = JSON.stringify([
    app.loaded,
    app.selected,
    app.sites.map((site) => [site.name, healthInfo(site).label, site.live, site.pending?.length]),
  ]);
  if (signature === app.sidebarRendered) return;
  app.sidebarRendered = signature;

  const items = app.sites.map((site) => {
    const info = healthInfo(site);
    const pending = site.pending?.length ?? 0;
    return h('li', {},
      h('button', {
        class: 'site-link',
        type: 'button',
        'aria-current': site.name === app.selected ? 'true' : 'false',
        onclick: () => select(site.name),
      },
        h('span', { class: `dot ${info.dot}`, title: info.label }),
        h('span', { class: 'site-link-text' },
          h('span', { class: 'site-link-name' }, site.name),
          h('span', { class: 'site-link-meta' }, `${info.label}${site.invalid ? '' : ` · ${site.live ? 'réel' : 'simulation'}`}`),
        ),
        pending ? h('span', { class: 'count', title: `${pending} validation(s) en attente` }, String(pending)) : null,
      ));
  });
  $('site-list').replaceChildren(...items);
  if (app.loaded && !items.length) {
    $('site-list').replaceChildren(h('li', { class: 'sidebar-empty' }, 'Aucun site pour le moment.'));
  }
}

function select(name) {
  app.selected = name;
  app.tab = 'overview';
  app.rendered = '';
  render();
}

/* Détail */
function currentSite() {
  return app.sites.find((site) => site.name === app.selected) ?? null;
}

function renderWelcome() {
  $('detail').dataset.key = '';
  $('detail').replaceChildren(
    can('admin')
      ? h('div', { class: 'welcome' },
        h('h1', {}, 'Associez votre premier site'),
        h('p', {}, "Indiquez le dossier du site et son adresse en ligne. L'agent commence en simulation et vous montre ce qu'il ferait, sans rien modifier."),
        h('button', { class: 'button primary', type: 'button', onclick: openAddDialog }, 'Associer un site'),
      )
      : h('div', { class: 'welcome' },
        h('h1', {}, 'Aucun site pour le moment'),
        h('p', {}, 'Un administrateur doit associer les sites. Ils apparaîtront ici.'),
      ),
  );
}

function setTab(tab) {
  app.tab = tab;
  app.rendered = '';
  render();
}

function siteHeader(site) {
  const info = healthInfo(site);
  const tone = info.dot === 'good' ? 'good' : info.dot === 'bad' ? 'bad' : '';
  return h('div', { class: 'site-header' },
    h('div', {},
      h('div', { class: 'site-title' },
        h('h1', {}, site.name),
        h('span', { class: `badge ${tone}` }, info.label),
        h('span', { class: `badge ${site.live ? 'live' : ''}` }, site.live ? 'Mode réel' : 'Simulation'),
      ),
      h('p', { class: 'site-sub' },
        site.urls.map((url) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url)),
      ),
      h('p', { class: 'site-sub mono' }, `${site.dir} · ${site.branch}`),
    ),
    can('admin')
      ? h('button', {
        class: 'button',
        type: 'button',
        disabled: app.working.has(`mode:${site.name}`),
        onclick: () => toggleMode(site),
      }, site.live ? 'Repasser en simulation' : 'Passer en mode réel')
      : null,
  );
}

async function toggleMode(site) {
  if (!site.live) {
    const accepted = await confirmAction({
      title: `Passer ${site.name} en mode réel ?`,
      text: "L'agent pourra modifier et déployer ce site selon vos règles, et faire des git reset --hard dans son dossier en cas de retour arrière. Ce dossier doit être une copie dédiée à l'agent.",
      ok: 'Passer en mode réel',
    });
    if (!accepted) return;
  }
  await perform(`mode:${site.name}`,
    () => api(sitePath(site.name, '/mode'), { method: 'POST', body: { live: !site.live } }),
    site.live ? 'Site repassé en simulation.' : 'Site passé en mode réel.');
}

async function runCycle(site, simulate) {
  if (!simulate) {
    const accepted = await confirmAction({
      title: `Lancer un cycle réel sur ${site.name} ?`,
      text: 'Si une mise à jour est autorisée par vos règles, elle sera déployée maintenant sur le site en ligne.',
      ok: 'Lancer',
    });
    if (!accepted) return;
  }
  await perform(`run:${site.name}`,
    () => api(sitePath(site.name, '/run'), { method: 'POST', body: { simulate } }),
    (report) => {
      if (report.applied) return RESULTS[report.applied.result] ?? report.applied.result;
      if (!report.decisions.length) return 'Aucune mise à jour détectée.';
      return simulate ? 'Simulation terminée : rien n\'a été modifié.' : 'Cycle terminé : rien à déployer pour le moment.';
    });
}

function metricsBlock(site) {
  const health = site.health;
  const healthy = health?.healthy;
  return h('div', { class: 'metrics' },
    h('div', { class: 'metric' },
      h('div', { class: 'metric-label' }, 'Santé'),
      h('div', { class: `metric-value ${health ? (healthy ? 'good' : 'bad') : ''}` }, health ? (healthy ? 'Bonne' : 'Dégradée') : '…'),
    ),
    h('div', { class: 'metric' },
      h('div', { class: 'metric-label' }, 'Temps de réponse'),
      h('div', { class: 'metric-value' }, health && health.errorRate < 1 ? `${health.p95LatencyMs} ms` : '—'),
    ),
    h('div', { class: 'metric' },
      h('div', { class: 'metric-label' }, 'En attente de vous'),
      h('div', { class: 'metric-value' }, String(site.pending.length)),
    ),
    h('div', { class: 'metric' },
      h('div', { class: 'metric-label' }, 'Dernière version saine'),
      h('div', { class: 'metric-value mono' }, site.lastKnownGood ? site.lastKnownGood.slice(0, 7) : '—'),
    ),
  );
}

const RECOMMENDATIONS = { apply: ['Feu vert', 'good'], review: ['À regarder', 'warn'], reject: ['Déconseillé', 'bad'] };

// Avis du modèle de langage sur un changement : résumé, points à vérifier, et risque relevé s'il y a lieu.
function advisorNote(item) {
  const review = item.advisor;
  if (!review) return null;
  if (review.error) return h('div', { class: 'advisor muted' }, `Analyse IA indisponible : ${review.error}`);
  const [label, tone] = RECOMMENDATIONS[review.recommendation] ?? [review.recommendation, ''];
  const raised = item.ruleRisk && item.ruleRisk !== item.risk ? ` · risque relevé de ${RISKS[item.ruleRisk] ?? item.ruleRisk} à ${RISKS[item.risk] ?? item.risk}` : '';
  return h('div', { class: 'advisor' },
    h('div', { class: 'advisor-head' }, h('span', { class: `badge ${tone}` }, `IA : ${label}`), h('span', { class: 'muted' }, `${review.model}${raised}`)),
    h('p', {}, review.summary),
    review.concerns?.length ? h('ul', {}, review.concerns.map((concern) => h('li', {}, concern))) : null,
  );
}

function pendingBlock(site) {
  const cards = site.pending.map((change) =>
    h('div', { class: 'change' },
      h('div', { class: 'change-main' },
        h('div', { class: 'change-title' }, change.title),
        h('div', { class: 'change-meta' }, `Risque ${RISKS[change.risk] ?? change.risk}${change.sensitive?.length ? ` · fichiers sensibles : ${change.sensitive.join(', ')}` : ''}`),
        advisorNote(change),
      ),
      change.approved
        ? h('span', { class: 'badge good' }, 'Approuvé')
        : !can('operator')
          ? h('span', { class: 'badge warn' }, 'En attente')
          : h('div', { class: 'change-actions' },
          h('button', {
            class: 'button small primary',
            type: 'button',
            disabled: app.working.has(`decide:${change.id}`),
            onclick: () => perform(`decide:${change.id}`, () => api(sitePath(site.name, '/approve'), { method: 'POST', body: { id: change.id } }), app.watching ? 'Approuvé : déploiement au prochain cycle.' : 'Approuvé : lancez un cycle réel pour déployer.'),
          }, 'Approuver'),
          h('button', {
            class: 'button small',
            type: 'button',
            disabled: app.working.has(`decide:${change.id}`),
            onclick: () => perform(`decide:${change.id}`, () => api(sitePath(site.name, '/reject'), { method: 'POST', body: { id: change.id } }), 'Refusé : cette version ne sera plus proposée.'),
          }, 'Refuser'),
        ),
    ));
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'À valider')),
    cards.length ? h('div', { class: 'card-list' }, cards) : h('div', { class: 'empty' }, 'Rien à valider.'),
  );
}

function decisionsBlock(site) {
  const last = site.lastReport;
  let content;
  if (!last) {
    content = h('div', { class: 'empty' }, "Lancez une simulation pour voir ce que l'agent ferait sur ce site.");
  } else if (!last.report.decisions.length) {
    content = h('div', { class: 'empty' }, 'Aucune mise à jour détectée.');
  } else {
    content = h('div', { class: 'card-list' },
      last.report.decisions.map((decision) => {
        const [label, tone] = OUTCOMES[decision.outcome] ?? [decision.outcome, ''];
        const executed = last.report.applied?.id === decision.id;
        let shown = label;
        if (decision.outcome === 'apply' && last.report.dryRun) shown = 'Serait appliqué';
        else if (executed) shown = last.report.applied.result === 'deployed' ? 'Déployé' : 'Non déployé';
        return h('div', { class: 'change' },
          h('div', { class: 'change-main' },
            h('div', { class: 'change-title' }, decision.title),
            h('div', { class: 'change-meta' }, `Risque ${RISKS[decision.risk] ?? decision.risk} · ${decision.reasons.join(' ; ')}`),
            advisorNote(decision),
          ),
          h('span', { class: `badge ${executed && last.report.applied.result !== 'deployed' ? 'bad' : tone}` }, shown),
        );
      }),
    );
  }
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Dernière analyse'),
      last ? h('span', { class: 'muted' }, `${last.report.dryRun ? 'Simulation' : 'Réel'} · ${formatDate(last.at)}`) : null,
    ),
    last?.report.applied ? h('p', { class: 'section-note' }, RESULTS[last.report.applied.result] ?? last.report.applied.result) : null,
    content,
  );
}

function renderOverview(site) {
  const runningSim = app.working.has(`run:${site.name}`) || site.busy;
  const nodes = [];

  if (site.paused) {
    nodes.push(h('div', { class: 'banner bad' },
      h('div', { class: 'banner-text' }, `Agent en pause sur ce site : ${site.paused.reason}`),
      can('operator') && h('button', {
        class: 'button small',
        type: 'button',
        disabled: app.working.has(`resume:${site.name}`),
        onclick: () => perform(`resume:${site.name}`, () => api(sitePath(site.name, '/resume'), { method: 'POST', body: {} }), 'Agent relancé sur ce site.'),
      }, 'Relancer'),
    ));
  } else if (site.health && !site.health.healthy) {
    nodes.push(h('div', { class: 'banner bad' }, h('div', { class: 'banner-text' }, `Problème détecté : ${site.health.reasons.join(' ; ')}`)));
  }
  if (site.live && !site.hasDeploy) {
    nodes.push(h('div', { class: 'banner warn' }, h('div', { class: 'banner-text' }, 'Aucune commande de déploiement configurée.')));
  }

  nodes.push(metricsBlock(site));
  if (can('operator')) {
    nodes.push(h('div', { class: 'actions' },
      h('button', { class: `button ${site.live ? '' : 'primary'}`, type: 'button', disabled: runningSim, onclick: () => runCycle(site, true) }, runningSim ? 'Analyse en cours…' : 'Simuler'),
      site.live ? h('button', { class: 'button primary', type: 'button', disabled: runningSim, onclick: () => runCycle(site, false) }, 'Lancer un cycle réel') : null,
    ));
  }
  nodes.push(pendingBlock(site));
  nodes.push(decisionsBlock(site));
  if (can('admin')) {
    nodes.push(h('section', { class: 'danger-zone' },
      h('button', { class: 'button danger', type: 'button', onclick: () => removeSite(site) }, 'Retirer ce site'),
    ));
  }
  return nodes;
}

async function removeSite(site) {
  const accepted = await confirmAction({
    title: `Retirer ${site.name} ?`,
    text: "L'agent cessera de s'en occuper. Les fichiers du site et son historique ne sont pas supprimés.",
    ok: 'Retirer',
    danger: true,
  });
  if (!accepted) return;
  await perform(`remove:${site.name}`, async () => {
    await api(sitePath(site.name), { method: 'DELETE' });
    app.selected = null;
  }, 'Site retiré.');
}

/* Réglages */
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
}

function textInput(object, key, props = {}) {
  return h('input', { value: object[key] ?? '', autocomplete: 'off', oninput: (event) => { object[key] = event.target.value; }, ...props });
}

function numberInput(object, key, props = {}) {
  return textInput(object, key, { type: 'number', min: '1', ...props });
}

function checkbox(label, object, key) {
  return h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: Boolean(object[key]), onchange: (event) => { object[key] = event.target.checked; } }),
    h('span', {}, label),
  );
}

function matrixPanel(draft) {
  const rows = [];
  let group = null;
  for (const row of draft.rows) {
    if (row.group !== group) {
      group = row.group;
      rows.push(h('tr', {}, h('th', { colSpan: 2, scope: 'colgroup' }, group)));
    }
    const options = AUTONOMY.filter(([value]) => value !== 'now' || row.allowNow);
    rows.push(h('tr', {},
      h('td', {}, row.label),
      h('td', {},
        h('select', {
          'aria-label': `${row.group} : ${row.label}`,
          onchange: (event) => { draft.matrix[row.key] = event.target.value; },
        }, options.map(([value, label]) => h('option', { value, selected: draft.matrix[row.key] === value }, label))),
      ),
    ));
  }
  return h('div', { class: 'panel' },
    h('h3', {}, 'Autonomie selon le risque'),
    h('p', { class: 'panel-note' }, 'Ce que l\'agent peut faire seul, et ce qui attend votre accord.'),
    draft.hasCustomRules ? h('p', { class: 'banner warn' }, 'Ce site a des règles personnalisées dans son fichier : modifier ce tableau les remplacera.') : null,
    h('table', { class: 'matrix' }, h('tbody', {}, rows)),
  );
}

function repeatable(list, renderRow, blank, addLabel) {
  const container = h('div', {});
  const draw = () => {
    container.replaceChildren(
      ...list.map((item, index) =>
        h('div', { class: 'row-item' },
          renderRow(item),
          h('button', { class: 'button small', type: 'button', onclick: () => { list.splice(index, 1); draw(); } }, 'Retirer'),
        )),
      h('button', { class: 'button small', type: 'button', onclick: () => { list.push(blank()); draw(); } }, addLabel),
    );
  };
  draw();
  return container;
}

function dayPicker(window) {
  window.days ??= DAYS.map(([value]) => value);
  return h('div', { class: 'days', role: 'group', 'aria-label': 'Jours' },
    DAYS.map(([value, label]) =>
      h('label', { class: 'day' },
        h('input', {
          type: 'checkbox',
          checked: window.days.includes(value),
          onchange: (event) => {
            window.days = event.target.checked ? [...window.days, value] : window.days.filter((day) => day !== value);
          },
        }),
        label,
      )),
  );
}

function schedulePanel(draft) {
  return h('div', { class: 'panel' },
    h('h3', {}, 'Calendrier'),
    h('p', { class: 'panel-note' }, 'Plages où les mises à jour automatiques sont permises. Sans plage, elles le sont à toute heure.'),
    h('div', { class: 'field-grid' },
      field('Fuseau horaire', textInput(draft, 'timezone'), 'Exemple : Europe/Paris, Africa/Douala'),
      field('Vérifier les mises à jour toutes les (minutes)', numberInput(draft, 'detectIntervalMinutes')),
    ),
    h('h3', {}, 'Plages autorisées'),
    repeatable(draft.windows, (window) => [
      dayPicker(window),
      field('Début', textInput(window, 'start', { type: 'time' })),
      field('Fin', textInput(window, 'end', { type: 'time' })),
    ], () => ({ days: DAYS.map(([value]) => value), start: '02:00', end: '05:00' }), 'Ajouter une plage'),
    h('h3', { class: 'spaced' }, 'Périodes de gel'),
    h('p', { class: 'panel-note' }, 'Aucune mise à jour pendant ces dates, même approuvée.'),
    repeatable(draft.freezes, (freeze) => [
      field('Du', textInput(freeze, 'from', { type: 'date' })),
      field('Au', textInput(freeze, 'to', { type: 'date' })),
    ], () => ({ from: '', to: '' }), 'Ajouter un gel'),
  );
}

function limitsPanel(draft) {
  const urls = { value: draft.urls.join('\n') };
  draft.readUrls = () => urls.value.split('\n');
  return h('div', { class: 'panel' },
    h('h3', {}, 'Santé et limites'),
    h('div', { class: 'field-grid' },
      field('Temps de réponse maximal (ms)', numberInput(draft, 'maxP95LatencyMs')),
      field('Mises à jour automatiques par 24 h', numberInput(draft, 'maxAutoPerDay')),
      field('Échecs de suite avant mise en pause', numberInput(draft, 'maxConsecutiveFailures')),
    ),
    field('Adresses à surveiller, une par ligne', h('textarea', {
      class: 'mono',
      rows: 2,
      value: urls.value,
      oninput: (event) => { urls.value = event.target.value; },
    })),
  );
}

function trackingPanel(draft) {
  draft.sources.forEach((source) => { source.keysText = (source.requiredKeys ?? []).join(', '); });
  return h('div', { class: 'panel' },
    h('h3', {}, 'Ce que l\'agent suit'),
    h('p', { class: 'panel-note' }, 'Les pannes sont toujours surveillées.'),
    checkbox('Dépendances npm', draft, 'dependenciesEnabled'),
    checkbox('Nouveau code sur la branche', draft, 'codeEnabled'),
    checkbox('Contenu depuis une source externe', draft, 'contentEnabled'),
    repeatable(draft.sources, (source) => [
      field('Nom', textInput(source, 'name')),
      field('Adresse de la source', textInput(source, 'url', { type: 'url' })),
      field('Fichier cible dans le site', textInput(source, 'target'), 'Exemple : public/catalogue.json'),
      field('Champs obligatoires (JSON)', textInput(source, 'keysText'), 'Séparés par des virgules. Vide si ce n\'est pas du JSON.'),
    ], () => ({ name: '', url: '', target: '', keysText: '' }), 'Ajouter une source'),
  );
}

function advisorPanel(draft) {
  const onError = h('select', { onchange: (event) => { draft.advisorOnError = event.target.value; } },
    [['rules', 'Décider avec les règles seules'], ['approval', 'Demander une validation humaine']].map(([value, label]) =>
      h('option', { value, selected: draft.advisorOnError === value }, label)));
  return h('div', { class: 'panel' },
    h('h3', {}, 'Analyse IA'),
    h('p', { class: 'panel-note' }, 'Un modèle de langage local (Ollama) lit chaque mise à jour et donne son avis. Il peut seulement relever le risque ou demander une validation : il n’autorise jamais ce que les règles retiennent.'),
    checkbox('Analyser chaque mise à jour', draft, 'advisorEnabled'),
    h('div', { class: 'field-grid' },
      field('Modèle Ollama', textInput(draft, 'advisorModel', { class: 'mono' }), 'Exemple : qwen2.5:7b'),
      field('Adresse d’Ollama', textInput(draft, 'advisorBaseUrl', { class: 'mono' })),
      field('Si le modèle ne répond pas', onError),
    ),
  );
}

function commandsPanel(draft) {
  return h('div', { class: 'panel' },
    h('h3', {}, 'Commandes'),
    h('p', { class: 'panel-note' }, 'Exécutées dans le dossier du site.'),
    h('div', { class: 'field-grid' }, COMMANDS.map(([key, label]) => field(label, textInput(draft.commands, key, { class: 'mono' })))),
  );
}

function prepareBody(draft) {
  const { rows, hasCustomRules, readUrls, ...body } = draft;
  body.urls = readUrls();
  body.sources = draft.sources.map(({ keysText, ...source }) => {
    const keys = keysText.split(',').map((key) => key.trim()).filter(Boolean);
    const { requiredKeys, format, ...rest } = source;
    return keys.length ? { ...rest, format: 'json', requiredKeys: keys } : { ...rest, ...(format ? { format } : {}) };
  });
  return body;
}

async function renderSettings(site, container) {
  container.replaceChildren(h('div', { class: 'empty' }, 'Chargement…'));
  let draft;
  try {
    draft = await api(sitePath(site.name, '/settings'));
  } catch (error) {
    container.replaceChildren(h('div', { class: 'form-error' }, error.message));
    return;
  }

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { class: 'button primary', type: 'button' }, 'Enregistrer');
  save.addEventListener('click', async () => {
    save.disabled = true;
    errorBox.hidden = true;
    try {
      await api(sitePath(site.name, '/settings'), { method: 'PUT', body: prepareBody(draft) });
      toast('Réglages enregistrés.', 'good');
      renderSettings(site, container);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      save.disabled = false;
    }
  });

  const panels = [matrixPanel(draft), schedulePanel(draft), limitsPanel(draft), trackingPanel(draft), advisorPanel(draft), commandsPanel(draft)];
  if (!can('admin')) {
    for (const control of panels.flatMap((panel) => [...panel.querySelectorAll('input, select, textarea, button')])) control.disabled = true;
    container.replaceChildren(h('p', { class: 'banner warn readonly-note' }, 'Lecture seule : seul un administrateur peut modifier les règles.'), ...panels);
    return;
  }
  container.replaceChildren(...panels, errorBox, h('div', { class: 'save-bar' }, save));
}

/* Historique */
async function renderHistory(site, container) {
  container.replaceChildren(h('div', { class: 'empty' }, 'Chargement…'));
  try {
    const { entries } = await api(sitePath(site.name, '/history'));
    if (!entries.length) {
      container.replaceChildren(h('div', { class: 'empty' }, "Rien pour l'instant. Les déploiements, retours arrière et alertes apparaîtront ici."));
      return;
    }
    container.replaceChildren(h('ol', { class: 'history' },
      entries.map((entry) =>
        h('li', {},
          h('time', { dateTime: entry.at }, formatDate(entry.at)),
          h('span', { class: `history-message ${entry.level}` }, entry.message),
        )),
    ));
  } catch (error) {
    container.replaceChildren(h('div', { class: 'form-error' }, error.message));
  }
}

/* Affichage général */
function renderDetailIfOverview(force = false) {
  if (app.tab !== 'overview') return;
  const site = currentSite();
  if (!site || site.invalid) return;
  const signature = JSON.stringify([site, [...app.working]]);
  if (!force && signature === app.rendered) return;
  app.rendered = signature;
  const content = $('tab-content');
  if (content) content.replaceChildren(...renderOverview(site));
  const header = $('site-header-slot');
  if (header) header.replaceChildren(siteHeader(site));
}

function render() {
  renderSidebar();

  if (!app.loaded) return;
  if (!app.sites.length) {
    renderWelcome();
    return;
  }

  if (!currentSite()) app.selected = app.sites[0].name;
  const site = currentSite();

  if (site.invalid) {
    $('detail').replaceChildren(h('div', { class: 'detail-inner' },
      h('h1', {}, site.name),
      h('p', { class: 'form-error' }, site.invalid),
    ));
    return;
  }

  // Le panneau ouvert n'est reconstruit qu'au changement d'onglet ou de site : un formulaire en cours de saisie reste intact.
  const key = `${site.name}:${app.tab}`;
  if ($('detail').dataset.key !== key || !$('tab-content')) {
    $('detail').dataset.key = key;
    const tabs = [['overview', 'Vue d\'ensemble'], ['settings', 'Règles et facteurs'], ['history', 'Historique']];
    $('detail').replaceChildren(h('div', { class: 'detail-inner' },
      h('div', { id: 'site-header-slot' }, siteHeader(site)),
      h('div', { class: 'tabs', role: 'tablist' },
        tabs.map(([value, label]) =>
          h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(app.tab === value), onclick: () => setTab(value) }, label)),
      ),
      h('div', { id: 'tab-content' }),
    ));
    if (app.tab === 'settings') renderSettings(site, $('tab-content'));
    else if (app.tab === 'history') renderHistory(site, $('tab-content'));
    else app.rendered = '';
  }
  renderDetailIfOverview();
}

async function refresh(force = false) {
  try {
    const { sites, watching } = await api('/sites');
    app.sites = sites;
    app.watching = watching;
    app.loaded = true;
    if (force) app.rendered = '';
    render();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/* Association d'un site */
function addSource() {
  return document.querySelector('input[name="add-source"]:checked').value;
}

function syncAddSource() {
  const fromGit = addSource() === 'git';
  $('add-git-row').hidden = !fromGit;
  $('add-dir-row').hidden = fromGit;
  $('add-detected').hidden = true;
}

function openAddDialog() {
  $('add-form').reset();
  $('add-error').hidden = true;
  syncAddSource();
  $('add-dialog').showModal();
  $('add-name').focus();
}

async function inspectDirectory() {
  const dir = $('add-dir').value.trim();
  $('add-detected').hidden = true;
  if (!dir) return;
  try {
    const info = await api('/inspect', { method: 'POST', body: { dir } });
    $('add-error').hidden = true;
    $('add-detected').textContent = `Détecté : branche ${info.branch ?? 'inconnue'}, dépôt distant ${info.remote ?? 'aucun'}${info.hasLock ? ', dépendances npm' : ''}.${info.isClean ? '' : ' Ce dossier contient des modifications non enregistrées.'}`;
    $('add-detected').hidden = false;
    for (const [command, value] of Object.entries(info.commands)) {
      const input = $(`add-${command}`);
      if (input && !input.value) input.value = value;
    }
  } catch (error) {
    $('add-error').textContent = error.message;
    $('add-error').hidden = false;
  }
}

async function submitAdd(event) {
  event.preventDefault();
  const name = $('add-name').value.trim();
  const url = $('add-url').value.trim();
  const fromGit = addSource() === 'git';
  $('add-submit').disabled = true;
  $('add-submit').textContent = fromGit ? 'Copie du dépôt…' : 'Associer';
  $('add-error').hidden = true;
  try {
    const commands = Object.fromEntries(COMMANDS.map(([key]) => [key, $(`add-${key}`).value.trim()]));
    const source = fromGit ? { gitUrl: $('add-git').value.trim() } : { dir: $('add-dir').value.trim() };
    const result = await api('/sites', {
      method: 'POST',
      body: { name, ...source, urls: url ? [url] : [], commands },
    });
    $('add-dialog').close();
    app.selected = name;
    app.tab = 'overview';
    toast(`Site ${name} associé, en simulation.`, 'good');
    const extra = result.warnings.filter((warning) => !warning.includes('reset --hard'));
    if (extra.length) toast(extra.join('\n'));
    await refresh(true);
  } catch (error) {
    $('add-error').textContent = error.message;
    $('add-error').hidden = false;
  } finally {
    $('add-submit').disabled = false;
    $('add-submit').textContent = 'Associer';
  }
}

async function toggleWatch() {
  const enabled = !app.watching;
  if (enabled && app.sites.some((site) => site.live)) {
    const accepted = await confirmAction({
      title: 'Activer la surveillance ?',
      text: "Les sites en mode réel pourront être mis à jour automatiquement selon vos règles, tant que cette application tourne.",
      ok: 'Activer',
    });
    if (!accepted) return;
  }
  $('watch-toggle').disabled = true;
  try {
    await api('/watch', { method: 'POST', body: { enabled } });
    toast(enabled ? 'Surveillance activée.' : 'Surveillance arrêtée.', 'good');
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    $('watch-toggle').disabled = false;
    await refresh(true);
  }
}

async function enterApp(user) {
  app.user = user;
  $('app-shell').hidden = false;
  $('topbar-actions').hidden = false;
  $('account-name').textContent = user.name;
  $('account-role').textContent = ROLE_LABELS[user.role];
  $('add-site').hidden = !can('admin');
  // Comptes, groupes et journal se gèrent dans l'administration Django.
  $('admin-link').hidden = !app.links.admin;
  if (app.links.admin) $('admin-link').href = app.links.admin;
  $('account-button').hidden = app.demo;
  app.sidebarRendered = '';
  $('detail').dataset.key = '';
  await refresh(true);
}

function showNoAccess() {
  $('auth').hidden = false;
  $('auth').replaceChildren(h('div', { class: 'auth-card' },
    h('h1', {}, 'Pas encore d’accès'),
    h('p', { class: 'muted' }, 'Votre compte existe, mais n’appartient à aucun groupe de l’agent. Demandez à un administrateur de vous ajouter au groupe Lecteurs, Opérateurs ou Administrateurs.'),
    h('button', { class: 'button primary', type: 'button', onclick: logout }, 'Se déconnecter'),
  ));
}

/* Mon compte */
function openAccount() {
  $('account-summary').textContent = `${app.user.email || app.user.id} · ${ROLE_LABELS[app.user.role]}`;
  $('account-password').href = app.links.password ?? '#';
  $('account-dialog').showModal();
}

async function logout() {
  await fetch(app.links.logout ?? '/comptes/deconnexion/', {
    method: 'POST',
    headers: { 'x-csrftoken': csrfToken() },
    credentials: 'same-origin',
  }).catch(() => {});
  location.assign(app.links.login ?? LOGIN_URL);
}

async function start() {
  const session = await api('/session');
  app.demo = session.demo;
  app.links = session.links ?? {};
  if (session.user) await enterApp(session.user);
  else if (session.noAccess) showNoAccess();
  else goToLogin();
}

$('add-site').addEventListener('click', openAddDialog);
$('add-cancel').addEventListener('click', () => $('add-dialog').close());
$('add-dir').addEventListener('change', inspectDirectory);
document.querySelectorAll('input[name="add-source"]').forEach((radio) => radio.addEventListener('change', syncAddSource));
$('add-form').addEventListener('submit', submitAdd);
$('watch-toggle').addEventListener('click', toggleWatch);
$('account-button').addEventListener('click', openAccount);
$('account-cancel').addEventListener('click', () => $('account-dialog').close());
$('logout-button').addEventListener('click', logout);

start().catch((error) => toast(error.message, 'bad'));
setInterval(() => { if (app.user && !document.hidden) refresh(); }, POLL_MS);
