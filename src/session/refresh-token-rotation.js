'use strict';

const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

class RefreshTokenRotationError extends Error {
  constructor(message, {
    code = 'REFRESH_TOKEN_ROTATION_FAILED',
    status = null,
    remoteCode = '',
    retryable = false,
  } = {}) {
    super(message);
    this.name = 'RefreshTokenRotationError';
    this.code = code;
    this.status = status;
    this.remoteCode = remoteCode;
    this.retryable = retryable;
  }
}

function remoteErrorDetails(payload = {}) {
  const error = payload && typeof payload.error === 'object' ? payload.error : {};
  return {
    code: String(error.code || payload.error_code || payload.code || payload.error || '').trim(),
    message: String(error.message || payload.error_description || payload.message || '').trim(),
  };
}

function localErrorCode(remoteCode) {
  if (remoteCode === 'refresh_token_reused') return 'REFRESH_TOKEN_REUSED';
  if (remoteCode === 'refresh_token_invalidated') return 'REFRESH_TOKEN_INVALIDATED';
  return 'REFRESH_TOKEN_ROTATION_REJECTED';
}

async function rotateOpenAiRefreshToken({
  refreshToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45000,
  tokenUrl = OPENAI_OAUTH_TOKEN_URL,
  clientId = CODEX_CLIENT_ID,
} = {}) {
  const currentRefreshToken = String(refreshToken || '').trim();
  if (!currentRefreshToken) {
    throw new RefreshTokenRotationError('refresh token is missing', {
      code: 'REFRESH_TOKEN_MISSING',
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new RefreshTokenRotationError('fetch implementation is unavailable', {
      code: 'REFRESH_TOKEN_ROTATION_FETCH_UNAVAILABLE',
    });
  }

  let response;
  try {
    // OAuth 2.0 token endpoints consume form-encoded parameters.  Sending
    // JSON makes the endpoint reject an otherwise valid refresh token before
    // it can rotate it.
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: clientId,
    });
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RefreshTokenRotationError(
      `refresh-token request failed: ${String(error?.message || error)}`,
      {
        code: 'REFRESH_TOKEN_ROTATION_NETWORK_ERROR',
        retryable: true,
      },
    );
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const remote = remoteErrorDetails(payload);
    throw new RefreshTokenRotationError(
      remote.message || `refresh-token request returned HTTP ${response.status}`,
      {
        code: localErrorCode(remote.code),
        status: response.status,
        remoteCode: remote.code,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  const nextRefreshToken = String(payload.refresh_token || '').trim();
  const accessToken = String(payload.access_token || '').trim();
  if (!nextRefreshToken || !accessToken) {
    throw new RefreshTokenRotationError(
      'refresh-token response did not include the next refresh token and access token',
      { code: 'REFRESH_TOKEN_ROTATION_INCOMPLETE', status: response.status },
    );
  }

  return {
    refreshToken: nextRefreshToken,
    accessToken,
    idToken: String(payload.id_token || '').trim(),
    expiresIn: Number(payload.expires_in || 0) || null,
    tokenType: String(payload.token_type || '').trim(),
    rotatedAt: new Date().toISOString(),
  };
}

module.exports = {
  CODEX_CLIENT_ID,
  OPENAI_OAUTH_TOKEN_URL,
  RefreshTokenRotationError,
  rotateOpenAiRefreshToken,
};
