let bundle: Readonly<Record<string, string>> | undefined;

/** Sets the translations of the display language: English message → translated one. */
export function setL10nBundle(value: Readonly<Record<string, string>> | undefined): void {
  bundle = value;
}

/** The translations in use, to hand them over to webviews. */
export function l10nBundle(): Readonly<Record<string, string>> {
  return bundle ?? {};
}

/**
 * Translates an English message and fills `{0}`, `{1}`… with the arguments, as `vscode.l10n.t` does. It
 * works the same in the extension host, in webviews and in tests, which have no `vscode` module.
 */
export function t(message: string, ...args: (string | number)[]): string {
  const text = bundle?.[message] ?? message;
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}
