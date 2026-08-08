// SPDX-License-Identifier: Apache-2.0

export const allowedCodeLanguages = new Set([
  'bash', 'json', 'yaml', 'javascript', 'typescript', 'python', 'go', 'java', 'rust', 'sql', 'hcl', 'dockerfile', 'markdown', 'text', 'mermaid'
]);

export function analyzeMarkdown(body) {
  const lines = body.split(/\r?\n/);
  const headings = [];
  const fences = [];
  let inFence = false;
  let currentFence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      if (!inFence) {
        currentFence = { language: fence[1].trim(), startLine: index + 1, lines: [] };
        inFence = true;
      } else {
        currentFence.endLine = index + 1;
        fences.push(currentFence);
        currentFence = undefined;
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      currentFence.lines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ level: heading[1].length, text: heading[2].trim(), line: index + 1 });
  }

  return { lines, headings, fences, unclosedFence: inFence, prose: stripFencedCode(body) };
}

export function stripFencedCode(body) {
  return body.replace(/```[^\n]*\n[\s\S]*?```/g, '');
}

export function extractImages(prose) {
  return [...prose.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => ({ alt: match[1].trim(), target: match[2] }));
}

export function extractLinks(prose) {
  return [...prose.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => ({ text: match[1].trim(), target: match[2] }));
}

export function slugifyHeading(text) {
  return text.toLowerCase().trim().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}
