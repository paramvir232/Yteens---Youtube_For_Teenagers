// Splits text into pieces small enough to travel in a query string.
//
// The text moderation service takes its input as ?text=..., so the binding limit is the
// PERCENT-ENCODED length, not the character count. encodeURIComponent turns every space
// into %20 and most punctuation into three bytes, so English prose inflates by roughly
// 1.3x. Chunking on raw characters produces URLs that are intermittently too long - a
// failure that looks like a server fault rather than a client bug.

// Encoded bytes per chunk. The real ceiling is imposed by whatever proxies that service
// and is unknown; 1500 survives essentially any proxy, CDN or server default.
const BUDGET = 1500;

const encodedLength = (text) => encodeURIComponent(text).length;

// A single sentence longer than the budget cannot be packed, so break it on word
// boundaries instead.
const hardSplit = (sentence, budget) => {
  const parts = [];
  let current = '';

  for (const word of sentence.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (encodedLength(candidate) > budget) {
      if (current) parts.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
};

// Splitting on sentence boundaries matters for accuracy: a chunk cut mid-sentence can
// change the apparent meaning of what it contains.
const chunkForQuery = (text, budget = BUDGET) => {
  if (!text || !text.trim()) return [];

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (encodedLength(sentence) > budget) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...hardSplit(sentence, budget));
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (encodedLength(candidate) > budget) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
};

module.exports = { chunkForQuery, encodedLength, BUDGET };
