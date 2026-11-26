// The option controls of the five generator tabs, as one two-way mapping
// between the DOM and a Settings object. Nothing here touches storage or
// the generator.
import { CHAR_CLASSES, ENCODINGS, LIMITS, type Settings, sanitize } from "../lib/settings.js";
import { byId } from "./dom.js";

export type OptionsForm = {
  /**
   * Settings as the controls show them now, sanitized. `source` is the
   * control the user just touched: the password length has two controls
   * and the touched one wins.
   */
  read(previous: Settings, source?: EventTarget | null): Settings;
  /**
   * Shows settings in the controls. `editing` is the control the user is
   * typing in right now; it is left alone unless more typing cannot make
   * its content valid.
   */
  write(settings: Settings, editing?: EventTarget | null): void;
};

type Range = { min: number; max: number };

function numberInput(id: string, range: Range): HTMLInputElement {
  const input = byId<HTMLInputElement>(id);
  input.min = String(range.min);
  input.max = String(range.max);
  return input;
}

function setOptions(select: HTMLSelectElement, values: readonly string[]): void {
  select.replaceChildren(...values.map((value) => new Option(value, value)));
}

// An empty or half-typed number ("", "-", "1e") reads as NaN. Keeping the
// previous value then stops sanitize() from snapping the option back to
// its default while the user is still typing.
function numberOr(input: HTMLInputElement, fallback: number): number {
  const n = input.valueAsNumber;
  return Number.isFinite(n) ? n : fallback;
}

// A number below the minimum may be the start of a valid one ("1" on the
// way to "16"), so the field being edited is corrected only when it is
// above the maximum. Everything is corrected on change (blur or Enter).
function putNumber(input: HTMLInputElement, value: number, editing: EventTarget | null): void {
  if (input === editing && !(input.valueAsNumber > Number(input.max))) return;
  if (input.value !== String(value)) input.value = String(value);
}

// Rewriting the value of a focused text field moves the caret to the end.
function putText(input: HTMLInputElement, value: string, editing: EventTarget | null): void {
  if (input !== editing && input.value !== value) input.value = value;
}

// A saved id the core does not list stays selectable. The core then
// explains what is wrong, instead of the popup silently switching to
// another character set.
function putChoice(select: HTMLSelectElement, value: string): void {
  if (!Array.from(select.options).some((option) => option.value === value)) {
    select.add(new Option(value, value));
  }
  select.value = value;
}

/** Binds the option controls. `charsets` are the ids the core offers. */
export function createOptionsForm(charsets: readonly string[]): OptionsForm {
  const pwLength = numberInput("pw-length", LIMITS.passwordLength);
  const pwLengthRange = numberInput("pw-length-range", LIMITS.passwordLength);
  const pwCharset = byId<HTMLSelectElement>("pw-charset");
  const pwClasses = CHAR_CLASSES.map(
    (name) => [name, byId<HTMLInputElement>(`pw-class-${name}`)] as const,
  );
  const pwExclude = byId<HTMLInputElement>("pw-exclude");
  const pwAllowWeak = byId<HTMLInputElement>("pw-allow-weak");

  const ppWords = numberInput("pp-words", LIMITS.passphraseWords);
  const ppSeparator = byId<HTMLInputElement>("pp-separator");
  const ppCapitalize = byId<HTMLInputElement>("pp-capitalize");
  const ppDigitSuffix = byId<HTMLInputElement>("pp-digit-suffix");

  const scBytes = numberInput("sc-bytes", LIMITS.secretBytes);
  const scEncoding = byId<HTMLSelectElement>("sc-encoding");
  const scPrefix = byId<HTMLInputElement>("sc-prefix");

  const akPrefix = byId<HTMLInputElement>("ak-prefix");
  const akSeparator = byId<HTMLInputElement>("ak-separator");
  const akLength = numberInput("ak-length", LIMITS.apiKeyLength);

  const pinDigits = numberInput("pin-digits", LIMITS.pinDigits);
  const pinAck = byId<HTMLInputElement>("pin-ack");

  setOptions(pwCharset, charsets);
  setOptions(scEncoding, ENCODINGS);

  return {
    read(previous, source = null) {
      const length = source === pwLengthRange ? pwLengthRange : pwLength;
      return sanitize({
        tab: previous.tab,
        password: {
          length: numberOr(length, previous.password.length),
          charsetId: pwCharset.value,
          exclude: pwExclude.value,
          requiredClasses: pwClasses.filter(([, box]) => box.checked).map(([name]) => name),
          allowWeak: pwAllowWeak.checked,
        },
        passphrase: {
          words: numberOr(ppWords, previous.passphrase.words),
          separator: ppSeparator.value,
          capitalize: ppCapitalize.checked,
          digitSuffix: ppDigitSuffix.checked,
        },
        secret: {
          bytes: numberOr(scBytes, previous.secret.bytes),
          encoding: scEncoding.value,
          prefix: scPrefix.value,
        },
        apiKey: {
          prefix: akPrefix.value,
          separator: akSeparator.value,
          length: numberOr(akLength, previous.apiKey.length),
        },
        pin: {
          digits: numberOr(pinDigits, previous.pin.digits),
          acknowledgeLowEntropy: pinAck.checked,
        },
      });
    },

    write(settings, editing = null) {
      const { password, passphrase, secret, apiKey, pin } = settings;
      putNumber(pwLength, password.length, editing);
      putNumber(pwLengthRange, password.length, editing);
      putChoice(pwCharset, password.charsetId);
      for (const [name, box] of pwClasses) box.checked = password.requiredClasses.includes(name);
      putText(pwExclude, password.exclude, editing);
      pwAllowWeak.checked = password.allowWeak;

      putNumber(ppWords, passphrase.words, editing);
      putText(ppSeparator, passphrase.separator, editing);
      ppCapitalize.checked = passphrase.capitalize;
      ppDigitSuffix.checked = passphrase.digitSuffix;

      putNumber(scBytes, secret.bytes, editing);
      putChoice(scEncoding, secret.encoding);
      putText(scPrefix, secret.prefix, editing);

      putText(akPrefix, apiKey.prefix, editing);
      putText(akSeparator, apiKey.separator, editing);
      putNumber(akLength, apiKey.length, editing);

      putNumber(pinDigits, pin.digits, editing);
      pinAck.checked = pin.acknowledgeLowEntropy;
    },
  };
}
