const ICONS = { info: 'ℹ️', warn: '⚠️', critical: '🚨', success: '✅' };

export class Notifier {
  constructor({ store, siteName = null, webhookUrl = null, fetchImpl = fetch, silent = false, now = () => new Date() }) {
    this.store = store;
    this.prefix = siteName ? `[${siteName}] ` : '';
    this.webhookUrl = webhookUrl;
    this.fetchImpl = fetchImpl;
    this.silent = silent;
    this.now = now;
  }

  async send(level, message, data = {}) {
    const entry = { at: this.now().toISOString(), level, message, ...data };
    if (!this.silent) console.log(`${ICONS[level] ?? ''} ${this.prefix}${message}`);
    await this.store.appendHistory(entry);
    if (!this.webhookUrl || level === 'info') return;
    try {
      await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `${ICONS[level] ?? ''} [site-agent] ${this.prefix}${message}` }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      // Une alerte qui échoue ne doit jamais interrompre une restauration en cours.
      console.error(`Notification non envoyée : ${error.message}`);
    }
  }
}
