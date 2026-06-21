/**
 * Insert the `/add-dir` pill (+ a trailing space for the caret to land)
 * at the current selection, replacing whatever TextNode slice the
 * slash-command typeahead provided. Used by SlashCommandPlugin when the
 * user selects the `/add-dir` entry.
 */

import { $createTextNode, type LexicalEditor, type TextNode } from "lexical";
import { $createAddDirTriggerNode } from "./trigger-node";

export function $insertAddDirTrigger(
	editor: LexicalEditor,
	nodeToReplace: TextNode | null,
) {
	editor.update(() => {
		const pill = $createAddDirTriggerNode();
		const trailing = $createTextNode(" ");
		if (nodeToReplace) {
			// `nodeToReplace` is the TextNode slice that held the `/add-dir`
			// query text (e.g. "/add-dir"). Swap it for the pill.
			nodeToReplace.replace(pill);
		}
		pill.insertAfter(trailing);
		// Caret goes just after the space — this is the position the
		// AddDirTypeaheadPlugin watches for subsequent keystrokes.
		trailing.select(1, 1);
	});
}
