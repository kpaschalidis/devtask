type OpenOptions = {
	directory?: boolean;
	multiple?: boolean;
	defaultPath?: string;
	title?: string;
	filters?: Array<{ name: string; extensions: string[] }>;
};

export async function open(
	_options?: OpenOptions,
): Promise<string | string[] | null> {
	return null;
}

export async function save(_options?: unknown): Promise<string | null> {
	return null;
}

export async function message(_message: string): Promise<void> {}

export async function ask(_message: string): Promise<boolean> {
	return false;
}

export async function confirm(_message: string): Promise<boolean> {
	return false;
}
