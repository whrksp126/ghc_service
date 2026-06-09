export function requireSecret(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required secret env: ${name}`);
  }
  return devFallback;
}
