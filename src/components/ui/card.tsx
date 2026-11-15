import Link from "next/link";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { Icon, type IconName } from "./icon";

type BoxElement = "div" | "section" | "li" | "article";

type BoxProps = HTMLAttributes<HTMLElement> & {
  as?: BoxElement;
};

/**
 * Kartu: one box holds one object. It holds no other Card and no Panel, and it never floats, so
 * it has an edge and no shadow.
 */
export function Card({ as: Element = "div", className, ...boxProps }: BoxProps) {
  return <Element {...boxProps} className={joinClassNames("ui-card", className)} />;
}

/**
 * Panel: one repeating form entry, or a group of detail facts, sitting directly on the page. It
 * has no border and is never pressable, and it holds no Card.
 */
export function Panel({ as: Element = "div", className, ...boxProps }: BoxProps) {
  return <Element {...boxProps} className={joinClassNames("ui-panel", className)} />;
}

type LinkCardProps = {
  href: string;
  title: ReactNode;
  as?: "div" | "li";
  className?: string;
  // Lines under the title.
  children?: ReactNode;
  // A status pill and a secondary link. They sit above the stretched link, so hovering them does
  // not show the card's hover ring and pressing them does not follow the card's link.
  trailing?: ReactNode;
};

/**
 * Kartu tautan: a whole card that goes to another page. The title is the one main link and is
 * stretched over the card. Anything in `trailing` is a sibling of that link, never a child.
 */
export function LinkCard({
  href,
  title,
  as: Element = "div",
  className,
  children,
  trailing,
}: LinkCardProps) {
  return (
    <Element className={joinClassNames("ui-link-card", className)}>
      <div className="ui-link-card-main">
        <Link href={href} className="ui-link-card-title">
          {title}
        </Link>
        {children}
      </div>
      {trailing ? <div className="ui-link-card-trailing">{trailing}</div> : null}
      <Icon name="chevron-right" className="ui-link-card-chevron" />
    </Element>
  );
}

type DetailRow = {
  label: string;
  value: ReactNode;
};

type DetailListProps = {
  rows: DetailRow[];
  // beside: the label column sits left of the value. stacked: each pair is a column with the label
  // above its value, for a Panel.
  layout?: "beside" | "stacked";
  className?: string;
};

/** Rincian: label and value pairs inside a Card or a Panel. */
export function DetailList({ rows, layout = "beside", className }: DetailListProps) {
  return (
    <dl className={joinClassNames("ui-detail-list", className)} data-layout={layout}>
      {rows.map((row) => (
        <div key={row.label} className="ui-detail-row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type FactProps = {
  icon: IconName;
  label: string;
  value: ReactNode;
  className?: string;
};

/** Fakta: one fact that needs no box. */
export function Fact({ icon, label, value, className }: FactProps) {
  return (
    <div className={joinClassNames("ui-fact", className)}>
      <span className="ui-fact-circle" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="ui-fact-text">
        <span className="ui-fact-label">{label}</span>
        <span className="ui-fact-value">{value}</span>
      </div>
    </div>
  );
}

type PageSectionProps = {
  title: string;
  // The outline "+" of a repeating list, at the right end of the heading row.
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
};

/** Bagian: a section of a page. It has a heading row, no box and no border. */
export function PageSection({ title, action, className, children }: PageSectionProps) {
  const headingId = useId();

  return (
    <section className={joinClassNames("ui-page-section", className)} aria-labelledby={headingId}>
      <div className="ui-page-section-heading">
        <h2 id={headingId}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
