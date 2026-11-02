"use client";

import { useEffect, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { kbdEventForAction } from "@/src/core";
import { useTouchDevice } from "@/lib/touch";

/**
 * Touch-only top-bar menu for actions that are keyboard-only on desktop:
 * session Find (Mod+F) and collapse/expand all of my thinking (Mod+T). It
 * fires the same window events the shortcuts dispatch. Renders nothing on
 * mouse devices, so the desktop top bar is unchanged.
 */
export function TouchActionsMenu() {
	const touch = useTouchDevice();
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (anchor.current?.contains(t)) return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	if (!touch) return null;
	const fire = (action: "find" | "toggle-user-thinking") => {
		setOpen(false);
		window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
	};
	const item = "flex items-center rounded-lg px-2.5 py-2 text-left text-foreground transition-colors hover:bg-accent";
	return (
		<>
			<button
				ref={anchor}
				type="button"
				data-testid="touch-actions"
				aria-label="Session actions"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<EllipsisIcon className="size-4" />
			</button>
			{open && (
				<MenuShell
					anchorRef={anchor}
					testid="touch-actions-menu"
					preferredSide="down"
					align="right"
					menuClass="flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<button type="button" data-testid="touch-find" onClick={() => fire("find")} className={item}>
						Find in session
					</button>
					<button type="button" data-testid="touch-toggle-thinking" onClick={() => fire("toggle-user-thinking")} className={item}>
						Collapse / expand my thinking
					</button>
				</MenuShell>
			)}
		</>
	);
}
