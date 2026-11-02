/**
 * Long-press detection for touch (the Android tablet build has no right-click).
 * `createLongPress` is the pure timer/slop state machine; `useLongPress`
 * wires it to React pointer events, touch pointers only, so mouse and pen
 * behavior (and the native contextmenu path) is untouched.
 */
import { useEffect, useMemo, useRef } from "react";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 8;

export interface LongPress {
	start(x: number, y: number): void;
	move(x: number, y: number): void;
	/** Pointer released: stops a pending timer, keeps the fired flag. */
	end(): void;
	/** True once if a long press fired since the last start; swallow the follow-up click. */
	consumeFired(): boolean;
	/** Pointer cancelled or unmounted: stops the timer and clears the flag. */
	cancel(): void;
}

export function createLongPress(
	onLongPress: (x: number, y: number) => void,
	opts: { delay?: number; slop?: number } = {},
): LongPress {
	const delay = opts.delay ?? LONG_PRESS_MS;
	const slop = opts.slop ?? LONG_PRESS_SLOP;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let ox = 0;
	let oy = 0;
	let fired = false;
	const clear = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return {
		start(x, y) {
			clear();
			fired = false;
			ox = x;
			oy = y;
			timer = setTimeout(() => {
				timer = null;
				fired = true;
				onLongPress(ox, oy);
			}, delay);
		},
		move(x, y) {
			if (timer !== null && Math.hypot(x - ox, y - oy) > slop) clear();
		},
		end: clear,
		consumeFired() {
			const f = fired;
			fired = false;
			return f;
		},
		cancel() {
			clear();
			fired = false;
		},
	};
}

/**
 * Spread the result onto an element. `onLongPress` gets the element the press
 * started on and the pointer's client coordinates.
 */
export function useLongPress<T extends HTMLElement>(
	onLongPress: ((el: T, x: number, y: number) => void) | undefined,
) {
	const cb = useRef(onLongPress);
	useEffect(() => {
		cb.current = onLongPress;
	});
	const target = useRef<T | null>(null);
	const lp = useMemo(
		() => createLongPress((x, y) => target.current && cb.current?.(target.current, x, y)),
		[],
	);
	useEffect(() => () => lp.cancel(), [lp]);
	return useMemo(
		() => ({
			onPointerDown: (e: React.PointerEvent<T>) => {
				if (e.pointerType !== "touch" || !cb.current) return;
				target.current = e.currentTarget;
				lp.start(e.clientX, e.clientY);
			},
			onPointerMove: (e: React.PointerEvent<T>) => {
				if (e.pointerType === "touch") lp.move(e.clientX, e.clientY);
			},
			onPointerUp: () => lp.end(),
			onPointerCancel: () => lp.cancel(),
			onClickCapture: (e: React.MouseEvent<T>) => {
				if (lp.consumeFired()) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
		}),
		[lp],
	);
}
