// auto     — transition fires immediately, no human input needed
// required — engine pauses and waits for an explicit gate close
// conditional — auto unless a condition is met (e.g. check failed)
export type GatePolicy = 'auto' | 'required' | 'conditional';
