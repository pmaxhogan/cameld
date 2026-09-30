/**
 * Raw MIME to the three fields classification needs. Nothing else from the
 * message survives this module: no headers, no HTML, no attachments.
 */
import PostalMime from "postal-mime";

import { MAX_CLASSIFY_CHARS } from "./classify.ts";

export interface ParsedMail {
  /** The `From:` header address, lower-cased. Never the envelope sender. */
  from: string;
  subject: string;
  text: string;
}

export async function parseMail(
  raw: ReadableStream<Uint8Array> | ArrayBuffer | string,
): Promise<ParsedMail> {
  const email = await PostalMime.parse(raw);
  return {
    from: (email.from?.address ?? "").trim().toLowerCase(),
    subject: (email.subject ?? "").trim(),
    text: deriveText(email.text, email.html),
  };
}

function deriveText(text: string | undefined, html: string | undefined): string {
  if (text !== undefined && text.trim() !== "") return text;
  return html === undefined ? "" : htmlToText(html);
}

const HIDDEN_BLOCK = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;
const LINE_BREAK = /<br\b[^<>]*>|<\/(?:p|div|tr|td|li|h\d)\s*>/gi;
const ANY_TAG = /<[^<>]*>/g;

/** Flatten HTML to searchable text. Not a renderer; just enough structure. */
export function htmlToText(html: string): string {
  let text = html.slice(0, MAX_CLASSIFY_CHARS).replaceAll(HIDDEN_BLOCK, " ");
  text = text.replaceAll(LINE_BREAK, "\n");
  let previous: string;
  do {
    previous = text;
    text = text.replaceAll(ANY_TAG, " ");
  } while (text !== previous);
  return text
    .replaceAll(/&nbsp;/gi, " ")
    .replaceAll(/&#(\d+);/g, (whole: string, digits: string) => {
      const point = Number.parseInt(digits, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/[ \t]+/g, " ")
    .trim();
}
