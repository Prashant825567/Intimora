// A deliberately small XML reader for machine-generated VAST documents. It
// keeps only what the ad player needs: element names (prefixes ignored),
// attributes, text and CDATA. Comments, declarations and doctypes are skipped,
// and mismatched closing tags never throw, so a truncated response cannot break
// playback.
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(?:lt);/g, "<")
    .replace(/&(?:gt);/g, ">")
    .replace(/&(?:quot);/g, "\"")
    .replace(/&(?:apos);/g, "'")
    .replace(/&(?:amp);/g, "&");
}

function findTagEnd(source, start) {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function parseTag(body) {
  const name = /^[^\s/>]+/.exec(body)?.[0] ?? "";
  const attrs = {};
  const expression = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of body.slice(name.length).matchAll(expression)) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return { name, attrs };
}

export function localName(name) {
  const index = typeof name === "string" ? name.indexOf(":") : -1;
  return index < 0 ? String(name ?? "").toLowerCase() : String(name).slice(index + 1).toLowerCase();
}

export function parseXml(source) {
  if (typeof source !== "string" || !source) return null;
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const append = (value, decoded = false) => {
    const top = stack[stack.length - 1];
    top.text += decoded ? value : decodeEntities(value);
  };

  let index = 0;
  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next < 0) { append(source.slice(index)); break; }
    if (next > index) append(source.slice(index, next));

    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", next)) {
      const end = source.indexOf("]]>", next + 9);
      append(end < 0 ? source.slice(next + 9) : source.slice(next + 9, end), true);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", next) || source.startsWith("<!", next)) {
      const end = source.indexOf(">", next);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    const close = findTagEnd(source, next);
    if (close < 0) break;
    const raw = source.slice(next + 1, close);

    if (raw.startsWith("/")) {
      const name = localName(raw.slice(1).trim());
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (localName(stack[depth].name) === name) { stack.length = depth; break; }
      }
    } else {
      const selfClosing = raw.trimEnd().endsWith("/");
      const { name, attrs } = parseTag(selfClosing ? raw.trimEnd().slice(0, -1) : raw);
      if (!name) { index = close + 1; continue; }
      const node = { name, attrs, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    index = close + 1;
  }

  return root;
}

export function childrenNamed(node, name) {
  const wanted = localName(name);
  return (node?.children ?? []).filter((child) => localName(child.name) === wanted);
}

export function firstChild(node, name) {
  return childrenNamed(node, name)[0] ?? null;
}

export function descendantsNamed(node, name, limit = 64) {
  const wanted = localName(name);
  const found = [];
  const queue = [...(node?.children ?? [])];
  while (queue.length && found.length < limit) {
    const current = queue.shift();
    if (localName(current.name) === wanted) found.push(current);
    queue.push(...current.children);
  }
  return found;
}

export function textOf(node) {
  return typeof node?.text === "string" ? node.text.trim() : "";
}
