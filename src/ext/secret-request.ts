import {
  secretRequestPrivacyNote,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";

/** Button label and privacy line for a secret request card, matching web's SecretRequestCard. */
export function secretRequestCopy(item: Pick<SecretRequestItem, "delivery">): {
  readonly submitLabel: string;
  readonly privacyNote: string;
} {
  return { submitLabel: "Save securely", privacyNote: secretRequestPrivacyNote(item) };
}
