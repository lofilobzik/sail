/**
 * Sailor codes: the anonymous player identity. A code is 20 chars of base32 (100 random bits),
 * generated in the browser and sent as ?player= so the server can keep challenge progress; anyone
 * holding it owns that progress. Same rule as Go store.ValidCode.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LENGTH = 20;
const PATTERN = /^[A-Z2-7]{20}$/;

/** A fresh random code. 32 divides 256, so masking a random byte to 5 bits is unbiased. */
export function newSailorCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  let code = '';
  for (const b of bytes) code += ALPHABET[b & 31];
  return code;
}

/** The code typed or pasted by a player (spaces, dashes and case ignored), or null when it is not one. */
export function normalizeSailorCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return PATTERN.test(code) ? code : null;
}

/** `XXXXX-XXXXX-XXXXX-XXXXX`, for reading and copying. */
export function formatSailorCode(code: string): string {
  return code.match(/.{1,5}/g)?.join('-') ?? code;
}
