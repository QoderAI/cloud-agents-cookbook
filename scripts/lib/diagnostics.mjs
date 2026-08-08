// SPDX-License-Identifier: Apache-2.0

export function diagnostic(rule, file, message, line) {
  return { rule, file: file.replaceAll('\\', '/'), ...(line ? { line } : {}), message };
}

export function formatDiagnostic(level, item) {
  const location = item.line ? `${item.file}:${item.line}` : item.file;
  return `${level.toUpperCase()} ${item.rule} ${location}\n${item.message}`;
}
