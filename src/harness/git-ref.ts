export function safeGitRef(value: string, field: string): string {
  const ref = value.trim();
  if (
    ref.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    hasUnsafeRefComponent(ref)
  ) {
    throw new Error(`${field} is not a safe git ref.`);
  }
  return ref;
}

function hasUnsafeRefComponent(ref: string): boolean {
  return ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"));
}
