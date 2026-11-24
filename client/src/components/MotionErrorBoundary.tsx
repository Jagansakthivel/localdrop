import React from 'react';

export class MotionErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    fallback?: React.ReactNode;
    name?: string;
  },
  {
    hasError: boolean;
    error: Error | null;
  }
> {
  state = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[LocalDrop Motion Error: ${this.props.name || 'Component'}]`,
      error,
      info.componentStack
    );
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }

    return this.props.children;
  }
}
