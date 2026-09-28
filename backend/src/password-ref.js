// The administrator save path and Oracle execution path must recognize the
// same reference syntax. A malformed recognized reference must never become a password.
const ENV_PREFIX = /^\s*env:/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function passwordEnvReference(value) {
  if (typeof value !== 'string' || !ENV_PREFIX.test(value)) return null;
  const name = value.replace(ENV_PREFIX, '').trim();
  return { name, valid: ENV_NAME.test(name) };
}
