/**
 * Error Boundary for Sidebar Views
 *
 * Catches render errors in child components and displays a friendly fallback UI
 * instead of crashing the entire sidebar.
 */

import { Component, type ComponentChildren } from "preact";

interface ErrorBoundaryProps {
  children: ComponentChildren;
  fallback?: (error: Error, reset: () => void) => ComponentChildren;
  name?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }) {
    const name = this.props.name || "Component";
    console.error(`[ErrorBoundary:${name}] Caught error:`, error);
    if (errorInfo.componentStack) {
      console.error(`[ErrorBoundary:${name}] Component stack:`, errorInfo.componentStack);
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <DefaultErrorFallback error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultErrorFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  return (
    <div class="nv2-error-boundary" role="alert">
      <div class="nv2-error-boundary-icon">!</div>
      <div class="nv2-error-boundary-title">Something went wrong</div>
      <div class="nv2-error-boundary-message">{error.message}</div>
      <button type="button" class="nv2-error-boundary-button" onClick={onReset}>
        Try Again
      </button>
    </div>
  );
}

/**
 * Wrap a view component with error boundary for isolation
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: (props: P) => ComponentChildren,
  name: string,
): (props: P) => ComponentChildren {
  return function BoundedComponent(props: P) {
    return (
      <ErrorBoundary name={name}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    );
  };
}
