/**
 * Shared primitives for interaction panels (permission approval, deferred
 * tool, elicitation form / url / unsupported). Each panel keeps its own
 * state logic and body composition; these primitives cover the repeated
 * shell (header, footer, option rows, optional-note input).
 */

export { InteractionFooter } from "./footer";
export { InteractionHeader } from "./header";
export { InteractionOptionRow } from "./option-row";
export { InteractionOptionalInput } from "./optional-input";
export {
	type InteractionStepTabItem,
	InteractionStepTabs,
} from "./step-tabs";
