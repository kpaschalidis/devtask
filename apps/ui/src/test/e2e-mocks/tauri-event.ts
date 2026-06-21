export type UnlistenFn = () => void;

export type EventCallback<T> = (event: { payload: T }) => void;

export async function listen<T = unknown>(
	_name: string,
	_handler: EventCallback<T>,
): Promise<UnlistenFn> {
	return () => {};
}
