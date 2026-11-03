/**
 * Shannon entropy calculation and false-positive whitelisting for secrets (#1512).
 */

/**
 * Calculates the Shannon entropy of a string in bits per character.
 * Higher entropy indicates greater randomness (typical of cryptographic keys and high-entropy secrets).
 * Low entropy indicates repetitive, structured, or dictionary-like strings.
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/** Standard UUID v4/v1 pattern: e.g. 123e4567-e89b-12d3-a456-426614174000 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Common placeholder, test fixture, and dummy values that should not trigger secret alerts */
export const BENIGN_SECRET_WHITELIST_EXACT: ReadonlySet<string> = new Set([
  "your_api_key",
  "your-api-key",
  "your_api_key_here",
  "your-api-key-here",
  "your_secret_key",
  "your-secret-key",
  "your_token_here",
  "your-token-here",
  "insert_key_here",
  "insert-key-here",
  "placeholder",
  "placeholder_token",
  "placeholder_key",
  "mock_token",
  "mock_api_key",
  "dummy_token",
  "dummy_key",
  "dummy_secret",
  "test_token",
  "test_secret",
  "test_api_key",
  "fake_token",
  "fake_secret",
  "fake_api_key",
  "example_token",
  "example_key",
  "changeme",
  "change_me",
  "change-me",
  "sample_token",
  "sample_secret",
  "sample_key",
  "null",
  "undefined",
  "none",
  "true",
  "false",
  "test",
  "demo",
]);

/**
 * Patterns indicating placeholder, mock, demo, or non-sensitive mock identifiers/tokens.
 */
export const BENIGN_PATTERN_REGEX =
  /^(?:your[_-]?(?:api[_-]?key|secret|token|password)(?:[_-]?here)?|dummy[_-]?(?:token|key|secret)|mock[_-]?(?:token|key|secret)|fake[_-]?(?:token|key|secret)|sample[_-]?(?:token|key|secret)|test[_-]?(?:token|key|secret)|example[_-]?(?:token|key|secret)|0{8,}|1{8,}|x{8,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

/**
 * Validates whether a potential secret token candidate is benign/whitelisted.
 * Returns true if the token is benign (safe to ignore, not a real secret).
 */
export function isBenignSecretCandidate(token: string): boolean {
  if (!token) return true;
  const trimmed = token.trim();
  if (trimmed.length === 0) return true;

  const lower = trimmed.toLowerCase();

  // 1. Exact whitelist match
  if (BENIGN_SECRET_WHITELIST_EXACT.has(lower)) {
    return true;
  }

  // 2. UUID structure
  if (UUID_REGEX.test(trimmed)) {
    return true;
  }

  // 3. Known placeholder patterns
  if (BENIGN_PATTERN_REGEX.test(trimmed)) {
    return true;
  }

  // 4. Repeated character sequence or low entropy mask (e.g. "************", "xxxxxxxx")
  const uniqueChars = new Set(trimmed).size;
  if (trimmed.length >= 8 && uniqueChars <= 2) {
    return true;
  }

  return false;
}

/**
 * Evaluates whether an identifier or value has sufficient entropy and characteristics
 * to be considered a genuine secret rather than a false positive.
 *
 * For tokens with length >= 16:
 * - If entropy < 2.5, it is considered too low-entropy (likely English/dictionary text or repeated chars).
 */
export function hasHighEntropy(token: string, minEntropy = 2.8): boolean {
  if (!token || token.length < 8) return false;
  if (isBenignSecretCandidate(token)) return false;

  const entropy = calculateShannonEntropy(token);
  return entropy >= minEntropy;
}
