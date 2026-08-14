import {
  isValidElement,
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

type ReportMarkdownProps = {
  source: string;
};

type ReportHastNode = {
  children?: ReportHastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type?: string;
  value?: string;
};

const blockedProtocolPattern = /^(?:javascript|data|vbscript):/i;
const headingIdPrefix = "report-heading-";
const mermaidNodePattern = '[A-Za-z][A-Za-z0-9_]{0,31}\\["[^"\\r\\n]+"\\]';
const mermaidChainPattern = new RegExp(
  `^${mermaidNodePattern}(?:\\s*-->\\s*${mermaidNodePattern}){2,5}$`,
);
const mermaidNodeCapturePattern =
  /([A-Za-z][A-Za-z0-9_]{0,31})\["([^"\r\n]+)"\]/g;
const unsafeDiagramLabelPattern =
  /[\u0000-\u001f\u007f<>]|(?:https?:\/\/|\/\/|www\.|mailto:|javascript:|data:)/iu;
const maxDiagramLabelLength = 32;

type ReportDiagramNode = {
  id: string;
  label: string;
};

function safeReportDestination(url: string) {
  const transformed = defaultUrlTransform(url);
  const normalizedProtocol = transformed
    .slice(0, transformed.indexOf(":") + 1)
    .replace(/[\u0000-\u0020]/g, "");

  if (blockedProtocolPattern.test(normalizedProtocol)) return "";
  return transformed;
}

export const safeReportUrl: UrlTransform = (url) =>
  safeReportDestination(url);

function isExternalDestination(href: string) {
  return /^(?:https?:|mailto:|\/\/)/i.test(href);
}

function visitElements(
  node: ReportHastNode,
  visitor: (element: ReportHastNode) => void,
) {
  if (node.type === "element") visitor(node);
  for (const child of node.children ?? []) visitElements(child, visitor);
}

function nodeText(node: ReportHastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "img" && typeof node.properties?.alt === "string") {
    return node.properties.alt;
  }
  return (node.children ?? []).map(nodeText).join("");
}

function conservativeHeadingSlug(value: string) {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(slug || "section").slice(0, 96).join("");
}

function decodeFragment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function reportHeadingFragments() {
  return (tree: ReportHastNode) => {
    const duplicateCounts = new Map<string, number>();
    const firstTargetBySlug = new Map<string, string>();
    const headingTagPattern = /^h[1-6]$/;
    const usedIds = new Set<string>();

    visitElements(tree, (element) => {
      if (!element.tagName || !headingTagPattern.test(element.tagName)) return;

      const slug = conservativeHeadingSlug(nodeText(element));
      const baseId = `${headingIdPrefix}${slug}`;
      let occurrence = (duplicateCounts.get(baseId) ?? 0) + 1;
      let id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;

      while (usedIds.has(id)) {
        occurrence += 1;
        id = `${baseId}-${occurrence}`;
      }

      duplicateCounts.set(baseId, occurrence);
      usedIds.add(id);
      if (!firstTargetBySlug.has(slug)) firstTargetBySlug.set(slug, id);
      element.properties = { ...element.properties, id };
    });

    visitElements(tree, (element) => {
      const href = element.properties?.href;
      if (element.tagName !== "a" || typeof href !== "string") return;
      if (!href.startsWith("#")) return;

      const decoded = decodeFragment(href.slice(1));
      const slug = conservativeHeadingSlug(decoded);
      const target = firstTargetBySlug.get(slug) ?? `${headingIdPrefix}${slug}`;
      element.properties = { ...element.properties, href: `#${target}` };
    });
  };
}

function visibleReactText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(visibleReactText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return visibleReactText(value.props.children);
  }
  return "";
}

function headingPriority(value: ReactNode) {
  const match = visibleReactText(value).match(
    /(?:^|[^\p{Letter}\p{Number}])P([0-3])(?=$|[^\p{Letter}\p{Number}])/iu,
  );
  return match?.[1];
}

function ShiftedHeading({
  level,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"h2"> & {
  level: 2 | 3 | 4 | 5 | 6;
}) {
  const Heading = `h${level}` as const;
  const priority = headingPriority(children);
  const priorityClass = priority
    ? `report-priority-heading report-priority-p${priority}`
    : "";
  const headingClassName = [className, priorityClass].filter(Boolean).join(" ");

  return (
    <Heading {...props} className={headingClassName || undefined}>
      {children}
    </Heading>
  );
}

function SafeLink({
  href,
  children,
  ...props
}: ComponentPropsWithoutRef<"a">) {
  const safeHref = href ? safeReportDestination(href) : "";

  if (!safeHref) {
    return <span className="report-unsafe-link">{children}</span>;
  }

  const external = isExternalDestination(safeHref);
  return (
    <a
      {...props}
      href={safeHref}
      rel={external ? "noopener noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}

function SafeImagePlaceholder({
  alt,
  title,
}: ComponentPropsWithoutRef<"img">) {
  const label = alt || title || "报告图片";
  return (
    <span className="report-image-placeholder" title={title}>
      图片已隐藏：{label}
    </span>
  );
}

function ScrollableTable({
  children,
  ...props
}: ComponentPropsWithoutRef<"table">) {
  return (
    <div
      aria-label="报告表格，可横向滚动"
      className="report-table-scroll"
      role="region"
      tabIndex={0}
    >
      <table {...props}>{children}</table>
    </div>
  );
}

function parseReportDiagram(source: string): ReportDiagramNode[] | null {
  if (source.length > 1_024) return null;

  const lines = source.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length !== 2 || lines[0].trim() !== "flowchart LR") return null;

  const chain = lines[1].trim();
  if (!mermaidChainPattern.test(chain)) return null;

  const nodes = Array.from(chain.matchAll(mermaidNodeCapturePattern), (match) => ({
    id: match[1],
    label: match[2],
  }));
  if (nodes.length < 3 || nodes.length > 6) return null;
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) return null;

  for (const node of nodes) {
    const labelLength = Array.from(node.label).length;
    if (
      node.label.trim() !== node.label ||
      labelLength === 0 ||
      labelLength > maxDiagramLabelLength ||
      unsafeDiagramLabelPattern.test(node.label)
    ) {
      return null;
    }
  }

  return nodes;
}

function splitDiagramLabel(label: string) {
  const characters = Array.from(label);
  if (characters.length <= 14) return [label];
  const midpoint = Math.ceil(characters.length / 2);
  return [
    characters.slice(0, midpoint).join(""),
    characters.slice(midpoint).join(""),
  ];
}

function ReportFlowchart({ nodes }: { nodes: ReportDiagramNode[] }) {
  const accessibleId = useId();
  const titleId = `${accessibleId}-title`;
  const descriptionId = `${accessibleId}-description`;
  const nodeWidth = 176;
  const nodeGap = 64;
  const inset = 24;
  const nodeHeight = 64;
  const nodeY = 25;
  const width = inset * 2 + nodes.length * nodeWidth + (nodes.length - 1) * nodeGap;

  return (
    <div
      aria-label="报告流程图，可横向滚动"
      className="report-diagram-scroll"
      role="region"
      tabIndex={0}
    >
      <svg
        aria-labelledby={`${titleId} ${descriptionId}`}
        className="report-flowchart"
        height="114"
        role="img"
        viewBox={`0 0 ${width} 114`}
        width={width}
      >
        <title id={titleId}>报告流程图</title>
        <desc id={descriptionId}>
          {nodes.map((node) => node.label).join("，依次流向：")}
        </desc>
        {nodes.slice(0, -1).map((node, index) => {
          const startX = inset + (index + 1) * nodeWidth + index * nodeGap;
          const endX = startX + nodeGap;
          const centerY = nodeY + nodeHeight / 2;
          return (
            <g aria-hidden="true" key={`${node.id}-edge`}>
              <line x1={startX} x2={endX - 9} y1={centerY} y2={centerY} />
              <path d={`M ${endX - 9} ${centerY - 5} L ${endX} ${centerY} L ${endX - 9} ${centerY + 5}`} />
            </g>
          );
        })}
        {nodes.map((node, index) => {
          const x = inset + index * (nodeWidth + nodeGap);
          const labelLines = splitDiagramLabel(node.label);
          return (
            <g key={node.id}>
              <rect height={nodeHeight} rx="8" width={nodeWidth} x={x} y={nodeY} />
              <text textAnchor="middle" x={x + nodeWidth / 2} y={nodeY + nodeHeight / 2}>
                {labelLines.map((line, lineIndex) => (
                  <tspan
                    dy={lineIndex === 0 ? (labelLines.length === 1 ? "0.35em" : "-0.2em") : "1.3em"}
                    key={`${node.id}-${lineIndex}`}
                    x={x + nodeWidth / 2}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DiagramAwarePre({
  children,
  ...props
}: ComponentPropsWithoutRef<"pre">) {
  if (
    isValidElement<{ className?: string; children?: ReactNode }>(children) &&
    children.props.className === "language-mermaid" &&
    typeof children.props.children === "string"
  ) {
    const diagram = parseReportDiagram(children.props.children);
    if (diagram) return <ReportFlowchart nodes={diagram} />;
  }

  return <pre {...props}>{children}</pre>;
}

function withoutMarkdownNode<T extends { node?: unknown }>({
  node,
  ...props
}: T): Omit<T, "node"> {
  void node;
  return props;
}

const reportComponents: Components = {
  h1: (props) => <ShiftedHeading {...withoutMarkdownNode(props)} level={2} />,
  h2: (props) => <ShiftedHeading {...withoutMarkdownNode(props)} level={3} />,
  h3: (props) => <ShiftedHeading {...withoutMarkdownNode(props)} level={4} />,
  h4: (props) => <ShiftedHeading {...withoutMarkdownNode(props)} level={5} />,
  h5: (props) => <ShiftedHeading {...withoutMarkdownNode(props)} level={6} />,
  h6: (props) => <ShiftedHeading {...withoutMarkdownNode(props)} level={6} />,
  a: (props) => <SafeLink {...withoutMarkdownNode(props)} />,
  img: (props) => <SafeImagePlaceholder {...withoutMarkdownNode(props)} />,
  pre: (props) => <DiagramAwarePre {...withoutMarkdownNode(props)} />,
  table: (props) => <ScrollableTable {...withoutMarkdownNode(props)} />,
};

export function ReportMarkdown({ source }: ReportMarkdownProps) {
  return (
    <ReactMarkdown
      components={reportComponents}
      rehypePlugins={[reportHeadingFragments]}
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeReportUrl}
    >
      {source}
    </ReactMarkdown>
  );
}
