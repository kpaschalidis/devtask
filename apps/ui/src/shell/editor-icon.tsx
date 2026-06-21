import { ExternalLink, SquareTerminal } from "lucide-react";
import {
	siAlacritty,
	siAndroidstudio,
	siClion,
	siCursor,
	siGhostty,
	siGitkraken,
	siGnuemacs,
	siGoland,
	siHyper,
	siIntellijidea,
	siIterm2,
	siNeovim,
	siPhpstorm,
	siPycharm,
	siRider,
	siRubymine,
	siSourcetree,
	siSublimetext,
	siTower,
	siVim,
	siWarp,
	siWebstorm,
	siWezterm,
	siWindsurf,
	siXcode,
	siZedindustries,
} from "simple-icons";

type SimpleIcon = { path: string };

// Keep in sync with `src-tauri/src/commands/editors.rs` CATALOG ids.
const SIMPLE_ICON_MAP: Record<string, SimpleIcon> = {
	cursor: siCursor,
	windsurf: siWindsurf,
	zed: siZedindustries,
	webstorm: siWebstorm,
	intellij: siIntellijidea,
	pycharm: siPycharm,
	goland: siGoland,
	clion: siClion,
	phpstorm: siPhpstorm,
	rubymine: siRubymine,
	rider: siRider,
	"android-studio": siAndroidstudio,
	xcode: siXcode,
	sublime: siSublimetext,
	macvim: siVim,
	neovide: siNeovim,
	emacs: siGnuemacs,
	iterm: siIterm2,
	warp: siWarp,
	ghostty: siGhostty,
	alacritty: siAlacritty,
	wezterm: siWezterm,
	hyper: siHyper,
	tower: siTower,
	sourcetree: siSourcetree,
	gitkraken: siGitkraken,
};

export function EditorIcon({
	editorId,
	className,
}: {
	editorId: string;
	className?: string;
}) {
	// Specials: simple-icons does not ship VS Code (Microsoft trademark),
	// and macOS Terminal has no brand logo.
	if (editorId === "vscode" || editorId === "vscode-insiders") {
		return (
			<svg className={className} viewBox="0 0 24 24" fill="currentColor">
				<title>VS Code</title>
				<path d="M17.58 2.39L10 9.43 4.64 5.42 2 6.76v10.48l2.64 1.34L10 14.57l7.58 7.04L22 19.33V4.67l-4.42-2.28zM4.64 15.36V8.64L7.93 12l-3.29 3.36zM17.58 17.6l-5.37-5.6 5.37-5.6v11.2z" />
			</svg>
		);
	}

	if (editorId === "terminal") {
		return <SquareTerminal className={className} strokeWidth={1.8} />;
	}

	const icon = SIMPLE_ICON_MAP[editorId];
	if (icon) {
		return (
			<svg className={className} viewBox="0 0 24 24" fill="currentColor">
				<path d={icon.path} />
			</svg>
		);
	}

	return <ExternalLink className={className} strokeWidth={1.8} />;
}
