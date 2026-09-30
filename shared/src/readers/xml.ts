import { XMLParser, XMLValidator } from "fast-xml-parser";

/** Thrown by the GPX and TCX readers for input they cannot read faithfully. */
export class ActivityReadError extends Error {
  override readonly name = "ActivityReadError";
}

/** A parsed XML element: child elements by local name, attributes as `@_name`, text as `#text`. */
export type XmlNode = Record<string, unknown>;

/**
 * Parse XML into plain objects. Namespace prefixes are stripped (GPX
 * extensions arrive as gpxtpx:, ns3: or anything else depending on the
 * exporter). Values stay strings so numbers are parsed exactly once, here in
 * the reader, with our own rules.
 */
export function parseXml(xml: string, arrayPaths: readonly string[]): XmlNode {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new ActivityReadError(`malformed XML: ${valid.err.msg} (line ${valid.err.line})`);
  }
  const arrays = new Set(arrayPaths);
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (_name, jpath) => arrays.has(String(jpath)),
  });
  return parser.parse(xml) as XmlNode;
}

/** Child element (or attribute) of a node, when the node is an object. */
export function child(node: unknown, key: string): unknown {
  return typeof node === "object" && node !== null ? (node as XmlNode)[key] : undefined;
}

/** Text content of a leaf that may carry attributes (then the text is under `#text`). */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const inner = child(value, "#text");
  return typeof inner === "string" ? inner : undefined;
}

/** A child's text parsed as a finite number, undefined when absent or empty. */
export function numberAt(node: unknown, key: string, where: string): number | undefined {
  const raw = text(child(node, key));
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ActivityReadError(`${where}: ${key} "${raw}" is not a number`);
  }
  return value;
}

/** A child's text parsed as an ISO 8601 timestamp in epoch ms, undefined when absent. */
export function timeAt(node: unknown, key: string, where: string): number | undefined {
  const raw = text(child(node, key));
  if (raw === undefined || raw === "") return undefined;
  const value = Date.parse(raw);
  if (Number.isNaN(value)) {
    throw new ActivityReadError(`${where}: ${key} "${raw}" is not a timestamp`);
  }
  return value;
}

/** A child's text, undefined when absent or empty. */
export function stringAt(node: unknown, key: string): string | undefined {
  const raw = text(child(node, key));
  return raw === undefined || raw === "" ? undefined : raw;
}

/** A child that the parser was told is always an array. */
export function listAt(node: unknown, key: string): unknown[] {
  const value = child(node, key);
  return Array.isArray(value) ? value : [];
}
