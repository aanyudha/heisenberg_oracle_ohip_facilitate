import { Component, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
export function Skeleton() {
  return (
    <div className="skeleton" aria-label="Loading" role="status">
      <div />
      <div />
      <div />
    </div>
  );
}
export function ErrorPanel({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="empty error" role="alert">
      <h3>We couldn't load this view</h3>
      <p>{message}</p>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}
export function State({
  query,
  children,
}: {
  query: UseQueryResult<any>;
  children: ReactNode;
}) {
  if (query.isPending) return <Skeleton />;
  if (query.isError)
    return (
      <ErrorPanel
        message={query.error.message}
        retry={() => void query.refetch()}
      />
    );
  return <>{children}</>;
}
export function Empty({
  text = "No records for this selection.",
}: {
  text?: string;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol">◇</span>
      <h3>All clear here</h3>
      <p>{text}</p>
    </div>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <ErrorPanel
        message="An unexpected display error occurred."
        retry={() => this.setState({ error: false })}
      />
    ) : (
      this.props.children
    );
  }
}
export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Pager({
  page,
  setPage,
  total,
  limit = 25,
}: {
  page: number;
  setPage: (p: number) => void;
  total: number;
  limit?: number;
}) {
  return (
    <div className="pager">
      <span>
        {total} records · Page {page}
      </span>
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
        Previous
      </button>
      <button
        disabled={page * limit >= total}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
