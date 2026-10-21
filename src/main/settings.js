// Tiny JSON settings store in the user's app-data folder.
// The Go Live stream key is encrypted with the OS keychain when available.

const fs = require('fs');
const path = require('path');

class Settings {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safe = safeStorage;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      this.data = {};
    }
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  setSecret(key, value) {
    if (!value) {
      delete this.data[key];
    } else if (this.safe && this.safe.isEncryptionAvailable()) {
      this.data[key] = { enc: this.safe.encryptString(value).toString('base64') };
    } else {
      this.data[key] = { plain: value };
    }
    this.save();
  }

  getSecret(key) {
    const v = this.data[key];
    if (!v) return '';
    try {
      if (v.enc) return this.safe.decryptString(Buffer.from(v.enc, 'base64'));
      return v.plain || '';
    } catch (_) {
      return '';
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (_) {
      /* settings are a convenience; never crash over them */
    }
  }
}

module.exports = { Settings };
