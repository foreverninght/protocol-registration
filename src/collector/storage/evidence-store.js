'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ensureDir } = require('../../storage/json-file');
const { isUtf8 } = require('node:buffer');
const { redactEventValue, redactString } = require('../../utils/redaction');

class EvidenceStore {
  constructor({ dataDir, taskId, store }) {
    if (!store) throw new TypeError('database runtime state store is required for evidence');
    this.store = store;
    this.taskId = String(taskId || '').trim();
    this.dir = path.join(dataDir, 'evidence', taskId);
    ensureDir(this.dir);
  }

  async record(event) {
    return this.store.appendEvidence({
      taskId: this.taskId,
      type: event?.type || 'evidence.event',
      payload: redactEventValue(event?.payload && typeof event.payload === 'object' ? event.payload : {}),
      createdAt: event?.at || null,
    });
  }

  artifactPath(name) {
    ensureDir(path.join(this.dir, 'artifacts'));
    const safe = String(name).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);
    return path.join(this.dir, 'artifacts', safe);
  }

  async writeArtifact(name, content, { encoding = 'utf8' } = {}) {
    const target = this.artifactPath(name);
    const safeContent = typeof content === 'string' ? redactString(content)
      : Buffer.isBuffer(content) && isUtf8(content) ? Buffer.from(redactString(content.toString('utf8')))
        : content;
    fs.writeFileSync(target, safeContent, { encoding, mode: 0o600 });
    const bytes = fs.statSync(target).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    await this.store.recordEvidenceArtifact({
      taskId: this.taskId,
      name: path.basename(target),
      relativePath: path.relative(this.dir, target),
      sha256,
      bytes,
    });
    return {
      path: target,
      bytes,
      sha256,
    };
  }

  async read({ afterSequence = 0, limit = 200 } = {}) {
    return this.store.listEvidence({ taskId: this.taskId, afterSequence, limit });
  }
}

module.exports = { EvidenceStore };
