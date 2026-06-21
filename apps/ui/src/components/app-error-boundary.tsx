import type { ReactNode } from "react";
import { Component } from "react";

type Props = {
	children: ReactNode;
};

type State = {
	error: Error | null;
};

export class AppErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, errorInfo: unknown) {
		console.error("[app] render failure", error, errorInfo);
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
					<div className="max-w-xl space-y-3">
						<h1 className="text-lg font-semibold">Helmor UI Copy Failed Open</h1>
						<p className="text-sm text-muted-foreground">
							The copied shell hit a render error. The app stayed mounted so we
							can continue integration without a blank screen.
						</p>
						<pre className="overflow-auto rounded-md border border-border bg-muted p-3 text-xs">
							{this.state.error.message}
						</pre>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}
