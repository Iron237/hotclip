/** Remove sentence punctuation without turning 3.5 into 35 or -2 into 2. */
export function stripCaptionPunctuation(text: string): string {
  return text.replace(/\p{P}/gu, (mark, offset: number) => {
    const before = text[offset - 1] ?? "",
      after = text[offset + mark.length] ?? "";
    if (/[0-9]/.test(before) && /[0-9]/.test(after) && /[./:]/.test(mark))
      return mark;
    if (mark === "-" && /[0-9]/.test(after)) return mark;
    return "";
  });
}

/** Keep English word spacing when rebuilding text from acoustic tokens. */
export function joinCaptionWords(words: { text: string }[]): string {
  return words.reduce(
    (text, word) =>
      text +
      (/[a-z][,.!?;:]?$/i.test(text) && /^[a-z]/i.test(word.text) ? " " : "") +
      word.text,
    "",
  );
}
