'use strict';

class VersionedSettings {
  constructor({ store, key }) {
    if (!store) throw new TypeError('database runtime state store is required');
    this.store = store;
    this.key = String(key || '').trim();
    this.value = null;
    this.version = null;
  }

  async initialize(defaultValue) {
    const row = await this.store.initializeSetting(this.key, defaultValue);
    this.value = row.value;
    this.version = row.version;
    return this.value;
  }

  get() {
    if (!this.value) {
      const error = new Error(`database setting was not initialized: ${this.key}`);
      error.code = 'SETTING_NOT_INITIALIZED';
      throw error;
    }
    return structuredClone(this.value);
  }

  async replace(value) {
    const row = await this.store.updateSetting(this.key, value, { expectedVersion: this.version });
    this.value = row.value;
    this.version = row.version;
    return this.get();
  }
}

module.exports = { VersionedSettings };
