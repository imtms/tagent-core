declare const credentialReferenceBrand: unique symbol;

/** Opaque name of a credential. The referenced secret never belongs in configuration or durable data. */
export type CredentialReference = string & { readonly [credentialReferenceBrand]: true };

const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function credentialReference(value: string): CredentialReference {
  if (!CREDENTIAL_REFERENCE_PATTERN.test(value)) {
    throw new TypeError(`Credential reference "${value}" must match ${String(CREDENTIAL_REFERENCE_PATTERN)}`);
  }
  return value as CredentialReference;
}

/** Trusted boundary that resolves a credential for one operation. Callers must not cache the value. */
export interface CredentialResolverPort {
  resolve(reference: CredentialReference): Promise<string | undefined> | string | undefined;
  configured(reference: CredentialReference): Promise<boolean> | boolean;
}

/** Environment-backed resolver for the trusted composition root. */
export function createEnvironmentCredentialResolver(
  environment: Readonly<NodeJS.ProcessEnv>,
): CredentialResolverPort {
  return Object.freeze({
    resolve(reference: CredentialReference) {
      const value = environment[reference]?.trim();
      return value || undefined;
    },
    configured(reference: CredentialReference) {
      return Boolean(environment[reference]?.trim());
    },
  });
}
