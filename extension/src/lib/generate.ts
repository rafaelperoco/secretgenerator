// One entry point for "make me a credential", shared by the popup and the
// background context so both go through the same validation.
import { type CrackTimeEstimate, callBinding, crackTimes } from "./wasm.js";
import { type Kind, type Settings, bindingOptions, sanitize } from "./settings.js";

export type Generated = {
  value: string;
  entropyBits: number;
  /**
   * The core's own count, whose unit depends on the kind: words for a
   * passphrase, and for an API key the random characters without prefix
   * and separator. Do not show it as the number of characters in `value`.
   */
  length: number;
  charsetId: string;
  /** Advisory messages from the core (weak PIN entropy, compatibility flags). */
  warnings: string[];
  crackTimes: CrackTimeEstimate[];
};

export type Estimate = {
  entropyBits: number;
  length: number;
  charsetSize: number;
  /** Comma-separated character classes observed, e.g. "lower,digit". */
  classes: string;
  crackTimes: CrackTimeEstimate[];
};

/** Generates a credential of the given kind. Throws with the core's message. */
export async function generate(kind: Kind, settings: Settings): Promise<Generated> {
  const res = await callBinding(kind, bindingOptions(kind, sanitize(settings)));
  if (typeof res.password !== "string" || res.password === "") {
    throw new Error("The generator core returned no value.");
  }
  return {
    value: res.password,
    entropyBits: res.entropy_bits,
    length: res.length,
    charsetId: res.charset_id,
    warnings: Array.isArray(res.warnings) ? res.warnings : [],
    crackTimes: await crackTimes(res.entropy_bits),
  };
}

/**
 * Upper-bound entropy estimate for an existing password. The input stays in
 * this context: it is not stored, logged or sent anywhere.
 */
export async function estimate(password: string): Promise<Estimate> {
  const res = await callBinding("entropy", { password: String(password) });
  return {
    entropyBits: res.entropy_bits,
    length: res.length,
    charsetSize: res.charset_size,
    classes: res.required_classes ?? "",
    crackTimes: await crackTimes(res.entropy_bits),
  };
}
