const SECRET_PATTERNS = [
  /\b(?:ask|sk|sk-or-v1)-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]+/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /https?:\/\/\S+/gi,
];

export class CliError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = options.exitCode || 1;
    this.code = options.code || null;
    this.status = options.status || null;
  }
}

export function redactSecrets(value) {
  let output = String(value || '');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output;
}

export function publicError(error) {
  if (error instanceof CliError) return error;
  const status = Number(error?.status || error?.response?.status || 0);
  const code = error?.code || error?.error?.code || error?.response?.data?.error?.code;
  if (status === 401 || code === 'invalid_api_key' || code === 'missing_api_key') {
    return new CliError('Authentication failed. Run "emper login" with a valid API key.', {
      code: 'authentication_failed', status: 401,
    });
  }
  if (status === 402 || code === 'insufficient_points') {
    return new CliError('Not enough points for this request.', { code:'insufficient_points', status:402 });
  }
  if (status === 429 || code === 'rate_limit_exceeded') {
    return new CliError('Request limit reached. Wait a moment and try again.', { code:'rate_limit_exceeded', status:429 });
  }
  if (status >= 500) {
    return new CliError('Emper service is temporarily unavailable. Try again in a moment.', {
      code:code || 'service_unavailable', status,
    });
  }
  const message = redactSecrets(error?.error?.message || error?.message || 'Request failed');
  return new CliError(message.slice(0, 500), { code, status: status || null });
}
