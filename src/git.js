import { runFile } from './exec.js';

const IDENTITY = ['-c', 'user.name=site-agent', '-c', 'user.email=site-agent@localhost'];

export class Git {
  constructor({ dir, remote, branch }) {
    this.dir = dir;
    this.remote = remote;
    this.branch = branch;
  }

  get remoteRef() {
    return `${this.remote}/${this.branch}`;
  }

  async #git(args, options = {}) {
    return runFile('git', args, { cwd: this.dir, ...options });
  }

  async #output(args) {
    return (await this.#git(args)).stdout.trim();
  }

  head() {
    return this.#output(['rev-parse', 'HEAD']);
  }

  revParse(ref) {
    return this.#output(['rev-parse', ref]);
  }

  async isClean() {
    return (await this.#output(['status', '--porcelain'])) === '';
  }

  async fetch() {
    await this.#git(['fetch', '--quiet', this.remote, this.branch]);
  }

  async isAncestor(ancestor, descendant) {
    const { exitCode } = await this.#git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
    return exitCode === 0;
  }

  async numstat(from, to) {
    const output = await this.#output(['diff', '--numstat', from, to]);
    if (!output) return [];
    return output.split('\n').map((line) => {
      const [added, deleted, ...file] = line.split('\t');
      return { file: file.join('\t'), added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
  }

  async changedFiles(from, to) {
    const output = await this.#output(['diff', '--name-only', from, to]);
    return output ? output.split('\n') : [];
  }

  async mergeFastForward(sha) {
    await this.#git(['merge', '--ff-only', '--quiet', sha]);
  }

  async commitAll(message) {
    await this.#git(['add', '-A']);
    const { exitCode } = await this.#git(['diff', '--cached', '--quiet'], { allowFailure: true });
    if (exitCode === 0) return false;
    await this.#git([...IDENTITY, 'commit', '--quiet', '-m', message]);
    return true;
  }

  // À n'appeler que sur un dépôt dont la propreté a été vérifiée avant l'opération.
  async restore(sha) {
    await this.#git(['reset', '--hard', '--quiet', sha]);
    await this.#git(['clean', '-fd', '--quiet']);
  }

  async push() {
    await this.#git(['push', '--quiet', this.remote, `HEAD:${this.branch}`]);
  }
}
