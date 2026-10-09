'use strict';

class Totp2faSetupError extends Error {
  constructor(message, { code = 'TOTP_2FA_SETUP_FAILED', status = null } = {}) {
    super(message);
    this.name = 'Totp2faSetupError';
    this.code = code;
    this.status = status;
    this.retryableProxy = false;
  }
}

async function setupTotp2fa({ page, accessToken, timeoutMs = 30000 }) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new Totp2faSetupError('browser page context is required for TOTP setup', {
      code: 'TOTP_2FA_PAGE_CONTEXT_MISSING',
    });
  }
  const token = String(accessToken || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new Totp2faSetupError('access token is required for TOTP setup', {
      code: 'TOTP_2FA_ACCESS_TOKEN_MISSING',
    });
  }

  const result = await page.evaluate(async ({ bearer, timeout }) => {
    const origin = 'https://chatgpt.com';
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    };

    async function request(path, method = 'GET', body = undefined) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeout) || 30000));
      try {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers,
          credentials: 'include',
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        return { ok: response.ok, status: response.status, data, text: text.slice(0, 800) };
      } finally {
        clearTimeout(timer);
      }
    }

    function activeFactorId(info) {
      const factors = info?.factors?.totp;
      if (!Array.isArray(factors)) return '';
      return String(factors.find((item) => item && item.id)?.id || '');
    }

    function base32Bytes(value) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const normalized = String(value || '').toUpperCase().replace(/[\s=-]/g, '');
      let bits = '';
      for (const char of normalized) {
        const index = alphabet.indexOf(char);
        if (index < 0) throw new Error('invalid TOTP secret');
        bits += index.toString(2).padStart(5, '0');
      }
      const bytes = [];
      for (let index = 0; index + 8 <= bits.length; index += 8) {
        bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
      }
      return new Uint8Array(bytes);
    }

    async function currentTotpCode(secret) {
      const counter = Math.floor(Date.now() / 1000 / 30);
      const counterBytes = new ArrayBuffer(8);
      const view = new DataView(counterBytes);
      view.setUint32(0, Math.floor(counter / 0x100000000));
      view.setUint32(4, counter >>> 0);
      const key = await crypto.subtle.importKey(
        'raw',
        base32Bytes(secret),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign'],
      );
      const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
      const offset = digest[digest.length - 1] & 0x0f;
      const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
      return String(binary % 1000000).padStart(6, '0');
    }

    const before = await request('/backend-api/accounts/mfa_info');
    if (!before.ok) {
      return {
        success: false,
        stage: 'mfa_info_before',
        status: before.status,
        error: before.data || before.text,
      };
    }
    const existingFactorId = activeFactorId(before.data);
    if (existingFactorId) {
      return {
        success: true,
        alreadyEnabled: true,
        activeFactorId: existingFactorId,
        beforeStatus: before.status,
        afterEnrollStatus: before.status,
        afterActivateStatus: before.status,
      };
    }

    const enrolled = await request('/backend-api/accounts/mfa/enroll', 'POST', { factor_type: 'totp' });
    const secret = String(enrolled.data?.secret || '').trim();
    const sessionId = String(enrolled.data?.session_id || '').trim();
    if (!enrolled.ok || !secret || !sessionId) {
      return {
        success: false,
        stage: 'mfa_enroll',
        status: enrolled.status,
        error: enrolled.data || enrolled.text,
      };
    }

    const afterEnroll = await request('/backend-api/accounts/mfa_info');
    const code = await currentTotpCode(secret);
    const activated = await request(
      '/backend-api/accounts/mfa/user/activate_enrollment',
      'POST',
      { code, factor_type: 'totp', session_id: sessionId },
    );
    const afterActivate = await request('/backend-api/accounts/mfa_info');
    const factorId = activeFactorId(afterActivate.data);
    if (!activated.ok || activated.data?.success !== true || !factorId) {
      return {
        success: false,
        stage: 'mfa_activate',
        status: activated.status,
        error: activated.data || activated.text,
        afterActivateStatus: afterActivate.status,
      };
    }
    return {
      success: true,
      alreadyEnabled: false,
      secret,
      enrollmentSessionId: sessionId,
      activeFactorId: factorId,
      beforeStatus: before.status,
      afterEnrollStatus: afterEnroll.status,
      afterActivateStatus: afterActivate.status,
    };
  }, { bearer: token, timeout: timeoutMs });

  if (!result?.success) {
    throw new Totp2faSetupError(
      `TOTP 2FA ${result?.stage || 'setup'} failed (HTTP ${result?.status || 0})`,
      { code: `TOTP_2FA_${String(result?.stage || 'SETUP').toUpperCase()}_FAILED`, status: result?.status || null },
    );
  }
  return result;
}

module.exports = { setupTotp2fa, Totp2faSetupError };
