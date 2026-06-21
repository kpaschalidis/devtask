export function getCurrentWindow() {
	return {
		onCloseRequested: async () => () => {},
		close: async () => {},
		setTitle: async () => {},
		show: async () => {},
		hide: async () => {},
		setBadgeCount: async () => {},
	};
}
