export function classifyCodeRisk(files, { maxLowRiskFiles, maxLowRiskLines, sensitivePaths }) {
  const patterns = sensitivePaths.map((pattern) => new RegExp(pattern));
  const sensitive = files.filter(({ file }) => patterns.some((pattern) => pattern.test(file))).map(({ file }) => file);
  const linesChanged = files.reduce((total, { added, deleted }) => total + added + deleted, 0);

  let risk = 'medium';
  if (sensitive.length) risk = 'high';
  else if (files.length <= maxLowRiskFiles && linesChanged <= maxLowRiskLines) risk = 'low';

  return { risk, sensitive, linesChanged, filesChanged: files.length };
}

export async function detect({ config, git, warn }) {
  await git.fetch();
  const head = await git.head();
  const target = await git.revParse(git.remoteRef);
  if (head === target) return [];

  if (!(await git.isAncestor(head, target))) {
    // Couvre aussi le cas où le distant est en retard : rien à déployer sans intervention.
    if (!(await git.isAncestor(target, head))) {
      await warn(`Historique divergent entre HEAD et ${git.remoteRef} : code non déployé.`);
    }
    return [];
  }

  const files = await git.numstat(head, target);
  const assessment = classifyCodeRisk(files, config.detectors.code);
  return [
    {
      id: `code:${target}`,
      type: 'code',
      title: `Code ${target.slice(0, 7)} : ${assessment.filesChanged} fichier(s), ${assessment.linesChanged} ligne(s)`,
      ...assessment,
      payload: { sha: target },
    },
  ];
}

export async function apply(change, { git }) {
  await git.mergeFastForward(change.payload.sha);
}
