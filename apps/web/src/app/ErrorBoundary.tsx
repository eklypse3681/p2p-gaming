import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="page page-narrow" role="alert" data-testid="error-boundary">
          <div className="card stack">
            <div className="eyebrow">Something went wrong</div>
            <h2>The table flipped over</h2>
            <p className="muted">{this.state.error.message}</p>
            <div className="row">
              <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
              <a className="btn" href="#/">
                Go home
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
