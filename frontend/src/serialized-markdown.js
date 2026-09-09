import { normalizeSerializedMarkdown } from '../../shared/serialized-markdown.mjs';
export { decodeSerializedLines, decodeVisualizationBreaks, decodeMathEscapes } from '../../shared/serialized-markdown.mjs';

export default function remarkSerializedMarkdown() {
  const processor = this;
  return (tree, file) => {
    const source = String(file);
    const normalized = normalizeSerializedMarkdown(source, tree, value => processor.parse(value));
    if (normalized === source) return tree;
    file.value = normalized;
    return processor.parse(normalized);
  };
}
