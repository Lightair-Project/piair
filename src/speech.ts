// From the model's streamed text to sentences the voice can speak: split early, check each piece
// before it's said.

/** Splits streamed text into speakable pieces. The first piece also breaks at a comma or dash
 * after 40 characters so the voice starts sooner. */
export class Splitter {
  private buf = "";
  private first = true;
  constructor(private emit: (piece: string) => void) {}

  push(delta: string) {
    this.buf += delta;
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) {
        this.first = false;
        this.emit(piece);
      }
    }
  }

  end() {
    const piece = this.buf.trim();
    this.buf = "";
    if (piece) this.emit(piece);
    this.first = true;
  }

  private findCut(): number {
    const b = this.buf;
    const m = /([.!?…]+["')\]]*)(\s+)|\n+/g;
    let r: RegExpExecArray | null;
    while ((r = m.exec(b))) {
      const end = r.index + r[0].length;
      // "Dr. ", "e.g. ", "3.5" don't end sentences
      const before = b.slice(Math.max(0, r.index - 4), r.index + 1);
      if (/\b(Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e)\.$/i.test(before)) continue;
      if (end - 0 >= 2) return end;
    }
    if (this.first && b.length >= 40) {
      const c = b.slice(40).search(/[,;:—–]\s/);
      if (c >= 0) return 40 + c + 2;
    }
    return -1;
  }
}

/** Makes text sayable: no markdown, no emoji, no links. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/__?([^_]+)__?/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Moderation, local and fast: runs on every piece before it goes to the voice.
const SLURS = [
  // a short, conservative list of slurs and their common spellings; matched as whole words
  "n[i1]gg(?:a|er|uh)s?", "f[a@]gg?(?:ot)?s?", "k[i1]kes?", "sp[i1]cs?", "ch[i1]nks?", "tr[a@]nn(?:y|ies)", "r[e3]t[a@]rds?", "wetbacks?", "g[o0]oks?",
];
const SLUR_RE = new RegExp(`\\b(?:${SLURS.join("|")})\\b`, "i");
const PROFANITY_RE = /\b(?:fuck\w*|shit\w*|cunt\w*|bitch\w*|dick(?:head)?s?|cock\w*|pussy|whore\w*|slut\w*|bastard\w*)\b/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE_RE = /(?:\+?\d[\s.-]?){9,}/;
const ADDRESS_RE = /\b\d{1,5}\s+\w+(?:\s\w+)?\s(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct)\b/i;
const LONG_NUMBER_RE = /\d{7,}/;

export interface Verdict {
  ok: boolean;
  reason?: string;
}

export function moderate(text: string, familyFriendly: boolean): Verdict {
  if (SLUR_RE.test(text)) return { ok: false, reason: "slur" };
  if (familyFriendly && PROFANITY_RE.test(text)) return { ok: false, reason: "profanity" };
  if (EMAIL_RE.test(text)) return { ok: false, reason: "personal data (email)" };
  if (PHONE_RE.test(text)) return { ok: false, reason: "personal data (phone number)" };
  if (ADDRESS_RE.test(text)) return { ok: false, reason: "personal data (address)" };
  if (LONG_NUMBER_RE.test(text)) return { ok: false, reason: "long number" };
  if (/(.)\1{7,}/.test(text)) return { ok: false, reason: "spam" };
  return { ok: true };
}
