"use client";

/**
 * Header left-slot context.
 *
 * The dashboard shell owns the sticky top header (search + bell icons on the
 * right). Individual pages sometimes need to place a control on the LEFT of
 * that same row — e.g. the dashboard's collection selector, which must sit on
 * one line with the icons per the design. Rather than duplicate the header or
 * lift page-specific state into the shell, a page renders its control into
 * this slot via <HeaderLeftSlot>, and the shell renders whatever's registered.
 *
 * Only one consumer is expected at a time (the active page); the slot clears
 * on unmount so navigating away leaves the header clean.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface HeaderSlotCtx {
  left: ReactNode;
  setLeft: (node: ReactNode) => void;
}

const Ctx = createContext<HeaderSlotCtx | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [left, setLeft] = useState<ReactNode>(null);
  return <Ctx.Provider value={{ left, setLeft }}>{children}</Ctx.Provider>;
}

/** Read the currently-registered left-slot node (used by the shell header). */
export function useHeaderLeft(): ReactNode {
  return useContext(Ctx)?.left ?? null;
}

/**
 * Render `children` into the header's left slot for as long as this component
 * is mounted. Clears the slot on unmount.
 */
export function HeaderLeftSlot({ children }: { children: ReactNode }) {
  const ctx = useContext(Ctx);
  useEffect(() => {
    ctx?.setLeft(children);
    return () => ctx?.setLeft(null);
  }, [ctx, children]);
  return null;
}
