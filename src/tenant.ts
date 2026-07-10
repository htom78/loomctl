const TENANT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export function assertTenantName(name: string): string {
  if (!TENANT_NAME_PATTERN.test(name)) {
    throw new Error("tenant name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,62}");
  }
  return name;
}
