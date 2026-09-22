/**
 * `String.prototype.isWellFormed` written for this repository's `ES2023` lib:
 * the method exists on Node 22+, but its type does not. A string is well formed
 * when every surrogate code unit belongs to a pair, so removing the pairs must
 * leave no surrogate behind.
 */
export function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDFFF]/.test(
    text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
  );
}
