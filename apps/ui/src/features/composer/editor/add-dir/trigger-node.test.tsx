import { $createTextNode, createEditor } from "lexical";
import { describe, expect, test } from "vitest";
import {
	$createAddDirTriggerNode,
	$isAddDirTriggerNode,
	AddDirTriggerNode,
} from "./trigger-node";

function makeEditor() {
	const editor = createEditor({ nodes: [AddDirTriggerNode] });
	// Need a host root element for Lexical to attach the editor state —
	// we use a detached div since we never render.
	const host = document.createElement("div");
	editor.setRootElement(host);
	return editor;
}

describe("AddDirTriggerNode", () => {
	test("reports the documented node type", () => {
		expect(AddDirTriggerNode.getType()).toBe("add-dir-trigger");
	});

	test("is inline and contributes its /add-dir text to plain-text export", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const node = $createAddDirTriggerNode();
				expect(node.isInline()).toBe(true);
				expect(node.getTextContent()).toBe("/add-dir");
			},
			{ discrete: true },
		);
	});

	test("exports JSON carrying the node type tag", () => {
		const editor = makeEditor();
		let exported: unknown;
		editor.update(
			() => {
				const pill = $createAddDirTriggerNode();
				exported = pill.exportJSON();
			},
			{ discrete: true },
		);
		// The exported shape is what Lexical persists in draft storage and
		// feeds back through importJSON on rehydrate. Guard the contract.
		expect(exported).toEqual({ type: "add-dir-trigger", version: 1 });
	});

	test("importJSON materializes a fresh AddDirTriggerNode", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const node = AddDirTriggerNode.importJSON({
					type: "add-dir-trigger",
					version: 1,
				});
				expect($isAddDirTriggerNode(node)).toBe(true);
			},
			{ discrete: true },
		);
	});

	test("type guard only matches AddDirTriggerNode instances", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const pill = $createAddDirTriggerNode();
				const text = $createTextNode("hello");
				expect($isAddDirTriggerNode(pill)).toBe(true);
				expect($isAddDirTriggerNode(text)).toBe(false);
				expect($isAddDirTriggerNode(null)).toBe(false);
			},
			{ discrete: true },
		);
	});
});
