import { createContext, useContext } from "react";

type FileLinkContextValue = {
	workspaceRootPath?: string | null;
	openInEditor?: (path: string, line?: number, column?: number) => void;
};

const FileLinkContext = createContext<FileLinkContextValue>({});

export const FileLinkProvider = FileLinkContext.Provider;

export function useFileLinkContext(): FileLinkContextValue {
	return useContext(FileLinkContext);
}
