// Small typed error so the UI can react to a code instead of parsing messages.
export class KbError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KbError';
    this.code = code;
    this.details = details;
  }
}

// Turns any thrown value into a short, user-facing sentence.
export function describeError(err) {
  if (err instanceof KbError) return err.message;
  const name = err && err.name;
  if (name === 'QuotaExceededError' || (err && err.inner && err.inner.name === 'QuotaExceededError')) {
    return 'Browser storage is full. Free some space or export a backup, then try again.';
  }
  if (name === 'DatabaseClosedError' || name === 'OpenFailedError' || name === 'InvalidStateError' || name === 'SecurityError') {
    return 'Browser storage is unavailable (private browsing or blocked site data?). Changes cannot be saved.';
  }
  return (err && err.message) || 'Something went wrong.';
}
