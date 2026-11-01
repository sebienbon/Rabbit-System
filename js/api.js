import { CONFIG } from './config.js';

export class ApiError extends Error {
  constructor(code, message, { network = false } = {}) { super(message); this.code = code; this.network = network; }
}

/** One call to the Apps Script Web App. text/plain avoids a CORS preflight. */
export async function api(action, body = {}, timeoutMs = 25000) {
  if (!CONFIG.API_URL) throw new ApiError('not_configured', 'Server address not set', { network: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...body }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError('offline', 'No connection to the server', { network: true });
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); } catch { throw new ApiError('bad_response', 'Server answered something unexpected (' + res.status + ')', { network: true }); }
  if (!data.ok) throw new ApiError(data.error || 'server_error', data.message || 'Server error', { network: data.error === 'busy' || data.error === 'server_error' });
  return data;
}
